package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

const (
	discordAuthorizeURL = "https://discord.com/oauth2/authorize"
	defaultRedirectURI  = "http://127.0.0.1:53682/callback"
	defaultAuthServer   = "https://guildsync.perdues.me"
)

type oauthRuntimeState struct {
	mu     sync.Mutex
	state  string
	server *http.Server
}

type GuildSyncClientConfig struct {
	DiscordClientID string `json:"discord_client_id"`
	RedirectURI     string `json:"redirect_uri"`
	AuthServerURL   string `json:"auth_server_url"`
	SocketURL       string `json:"socket_url"`
}

/*
These defaults are safe to bundle into the desktop app.

DO put these in the desktop app:
- Discord Client ID
- Redirect URI
- Auth server URL
- Socket URL

DO NOT put these in the desktop app:
- Discord Client Secret
- GuildSync JWT secret
- Database passwords
- Admin keys

The optional guildsync-client.json file can still override these values
for development/testing.
*/
var defaultGuildSyncClientConfig = GuildSyncClientConfig{
	DiscordClientID: "1511276915309281370",
	RedirectURI:     defaultRedirectURI,
	AuthServerURL:   defaultAuthServer,
	SocketURL:       defaultAuthServer,
}

type GuildSyncUser struct {
	DiscordUserID string               `json:"discord_user_id"`
	Username      string               `json:"username"`
	DisplayName   string               `json:"display_name"`
	Avatar        string               `json:"avatar"`
	AvatarURL     string               `json:"avatar_url"`
	Email         string               `json:"email,omitempty"`
	Role          string               `json:"role"`
	GlobalName    string               `json:"global_name,omitempty"`
	ActualRole    string               `json:"actual_role,omitempty"`
	UserSwitch    *GuildSyncUserSwitch `json:"user_switch,omitempty"`
}

type GuildSyncUserSwitch struct {
	Epoch      string `json:"epoch"`
	Active     bool   `json:"active"`
	Revision   int64  `json:"revision"`
	CanSwitch  bool   `json:"can_switch"`
	ActorID    string `json:"actor_id"`
	ActorName  string `json:"actor_name"`
	TargetID   string `json:"target_id"`
	TargetName string `json:"target_name"`
}

type GuildSyncSession struct {
	LoggedIn      bool          `json:"logged_in"`
	Allowed       bool          `json:"allowed"`
	Token         string        `json:"token,omitempty"`
	ExpiresAt     time.Time     `json:"expires_at,omitempty"`
	User          GuildSyncUser `json:"user"`
	SocketURL     string        `json:"socket_url"`
	AuthServerURL string        `json:"auth_server_url"`
	StatusMessage string        `json:"status_message"`
}

type desktopTokenRequest struct {
	Code        string `json:"code"`
	RedirectURI string `json:"redirect_uri"`
}

type desktopTokenResponse struct {
	OK        bool          `json:"ok"`
	Allowed   bool          `json:"allowed"`
	Token     string        `json:"token"`
	ExpiresAt time.Time     `json:"expires_at"`
	User      GuildSyncUser `json:"user"`
	Message   string        `json:"message"`
	Error     string        `json:"error"`
}

func (a *App) StartDiscordLogin() (GuildSyncSession, error) {
	cfg, err := LoadGuildSyncClientConfig()
	if err != nil {
		return GuildSyncSession{}, err
	}

	state, err := randomState()
	if err != nil {
		return GuildSyncSession{}, err
	}

	if err := a.startDiscordCallbackServer(cfg, state); err != nil {
		return GuildSyncSession{}, err
	}

	params := url.Values{}
	params.Set("response_type", "code")
	params.Set("client_id", cfg.DiscordClientID)
	params.Set("redirect_uri", cfg.RedirectURI)
	params.Set("scope", "identify email")
	params.Set("state", state)
	params.Set("prompt", "consent")

	runtime.BrowserOpenURL(a.ctx, discordAuthorizeURL+"?"+params.Encode())

	return GuildSyncSession{
		LoggedIn:      false,
		Allowed:       false,
		SocketURL:     cfg.SocketURL,
		AuthServerURL: cfg.AuthServerURL,
		StatusMessage: "Discord login opened in your browser.",
	}, nil
}

func (a *App) GetGuildSyncSession() (GuildSyncSession, error) {
	session, err := loadGuildSyncSession()
	if err != nil {
		cfg, _ := LoadGuildSyncClientConfig()

		return GuildSyncSession{
			LoggedIn:      false,
			Allowed:       false,
			SocketURL:     cfg.SocketURL,
			AuthServerURL: cfg.AuthServerURL,
			StatusMessage: "Not logged in.",
		}, nil
	}

	if !session.ExpiresAt.IsZero() && session.ExpiresAt.Before(time.Now()) {
		_ = DeleteGuildSyncSession()

		cfg, _ := LoadGuildSyncClientConfig()

		return GuildSyncSession{
			LoggedIn:      false,
			Allowed:       false,
			SocketURL:     cfg.SocketURL,
			AuthServerURL: cfg.AuthServerURL,
			StatusMessage: "Session expired. Please log in again.",
		}, nil
	}
	return verifyGuildSyncSession(session), nil
}

func verifyGuildSyncSession(session GuildSyncSession) GuildSyncSession {
	unverified := GuildSyncSession{
		SocketURL: session.SocketURL, AuthServerURL: session.AuthServerURL,
		StatusMessage: "Could not verify your session. Please try again.",
	}
	if session.Token == "" {
		return unverified
	}
	endpoint := strings.TrimRight(session.AuthServerURL, "/") + "/api/auth/session"
	req, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return unverified
	}
	req.Header.Set("Authorization", "Bearer "+session.Token)
	client := http.Client{Timeout: 5 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return unverified
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized {
		_ = DeleteGuildSyncSession()
		unverified.StatusMessage = "Session ended. Please log in again."
		return unverified
	}
	if resp.StatusCode != http.StatusOK {
		return unverified
	}
	var verified struct {
		OK   bool          `json:"ok"`
		User GuildSyncUser `json:"user"`
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	if err != nil || json.Unmarshal(body, &verified) != nil || !verified.OK ||
		strings.TrimSpace(verified.User.DiscordUserID) == "" || strings.TrimSpace(verified.User.Role) == "" {
		return unverified
	}
	// The server resolves the effective identity; the persisted token remains the actor's.
	session.User = verified.User
	session.LoggedIn = true
	session.Allowed = true
	return session
}

func (a *App) LogoutGuildSync() (GuildSyncSession, error) {
	_ = a.SetVoiceHotkeyActive(false)
	session, _ := loadGuildSyncSession()
	if session.Token != "" {
		endpoint := strings.TrimRight(session.AuthServerURL, "/") + "/api/auth/logout"
		req, err := http.NewRequest(http.MethodPost, endpoint, nil)
		if err != nil {
			return GuildSyncSession{}, err
		}
		req.Header.Set("Authorization", "Bearer "+session.Token)
		client := http.Client{Timeout: 10 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			return GuildSyncSession{}, fmt.Errorf("could not log out on the server: %w", err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusUnauthorized {
			return GuildSyncSession{}, fmt.Errorf("server could not log out (HTTP %d)", resp.StatusCode)
		}
	}
	if err := DeleteGuildSyncSession(); err != nil {
		return GuildSyncSession{}, err
	}

	cfg, _ := LoadGuildSyncClientConfig()

	return GuildSyncSession{
		LoggedIn:      false,
		Allowed:       false,
		SocketURL:     cfg.SocketURL,
		AuthServerURL: cfg.AuthServerURL,
		StatusMessage: "Logged out.",
	}, nil
}

func (a *App) GetGuildSyncClientConfig() (GuildSyncClientConfig, error) {
	return LoadGuildSyncClientConfig()
}

func (a *App) startDiscordCallbackServer(cfg GuildSyncClientConfig, expectedState string) error {
	if a.oauth == nil {
		a.oauth = &oauthRuntimeState{}
	}

	a.oauth.mu.Lock()
	defer a.oauth.mu.Unlock()

	if a.oauth.server != nil {
		_ = a.oauth.server.Shutdown(context.Background())
		a.oauth.server = nil
	}

	redirectURL, err := url.Parse(cfg.RedirectURI)
	if err != nil {
		return fmt.Errorf("invalid redirect URI: %w", err)
	}

	listener, err := net.Listen("tcp", redirectURL.Host)
	if err != nil {
		return fmt.Errorf("could not start local Discord OAuth callback server on %s: %w", redirectURL.Host, err)
	}

	mux := http.NewServeMux()
	server := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	a.oauth.state = expectedState
	a.oauth.server = server

	mux.HandleFunc(redirectURL.Path, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}

		code := r.URL.Query().Get("code")
		returnedState := r.URL.Query().Get("state")
		errorText := r.URL.Query().Get("error")

		if errorText != "" {
			a.finishOAuthWithError(w, "Discord login was cancelled or denied.")
			return
		}

		if code == "" {
			a.finishOAuthWithError(w, "Discord did not return an authorization code.")
			return
		}

		if returnedState == "" || returnedState != expectedState {
			a.finishOAuthWithError(w, "Discord login failed because the security state did not match.")
			return
		}

		session, err := exchangeCodeWithGuildSyncServer(cfg, code)
		if err != nil {
			a.finishOAuthWithError(w, err.Error())
			return
		}

		if !session.Allowed {
			a.finishOAuthWithDenied(w, session.StatusMessage)
			return
		}

		if err := saveGuildSyncSession(session); err != nil {
			a.finishOAuthWithError(w, "Login worked, but GuildSync could not save the session: "+err.Error())
			return
		}

		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.WriteString(
			w,
			htmlResultPage(
				"GuildSync login complete",
				"You are authenticated and approved to use GuildSync.",
				"You can close this browser tab and return to GuildSync.",
				"success",
			),
		)
		runtime.EventsEmit(a.ctx, "guildsync-login-complete", session)
		go a.stopDiscordCallbackServerSoon()
	})

	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			runtime.EventsEmit(a.ctx, "guildsync-login-failed", err.Error())
		}
	}()

	return nil
}

func (a *App) finishOAuthWithError(w http.ResponseWriter, message string) {
	if message == "" {
		message = "GuildSync could not complete Discord login."
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusBadRequest)

	_, _ = io.WriteString(
		w,
		htmlResultPage(
			"GuildSync login issue",
			message,
			"You can close this browser tab and return to GuildSync.",
			"error",
		),
	)

	runtime.EventsEmit(a.ctx, "guildsync-login-failed", message)
	go a.stopDiscordCallbackServerSoon()
}

func (a *App) finishOAuthWithDenied(w http.ResponseWriter, message string) {
	if message == "" {
		message = "Your Discord account was authenticated, but access to GuildSync is pending approval."
	}

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusForbidden)

	_, _ = io.WriteString(
		w,
		htmlResultPage(
			"GuildSync access pending",
			message,
			"Your access request has been recorded. You can close this browser tab and return to GuildSync.",
			"pending",
		),
	)

	runtime.EventsEmit(a.ctx, "guildsync-login-denied", message)
	go a.stopDiscordCallbackServerSoon()
}

func (a *App) stopDiscordCallbackServerSoon() {
	time.Sleep(500 * time.Millisecond)

	if a.oauth == nil {
		return
	}

	a.oauth.mu.Lock()
	defer a.oauth.mu.Unlock()

	if a.oauth.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()

		_ = a.oauth.server.Shutdown(ctx)
		a.oauth.server = nil
	}
}

func exchangeCodeWithGuildSyncServer(cfg GuildSyncClientConfig, code string) (GuildSyncSession, error) {
	payload := desktopTokenRequest{
		Code:        code,
		RedirectURI: cfg.RedirectURI,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return GuildSyncSession{}, err
	}

	endpoint := strings.TrimRight(cfg.AuthServerURL, "/") + "/api/auth/discord/desktop-token"

	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return GuildSyncSession{}, err
	}

	req.Header.Set("Content-Type", "application/json")

	client := http.Client{
		Timeout: 20 * time.Second,
	}

	resp, err := client.Do(req)
	if err != nil {
		return GuildSyncSession{}, fmt.Errorf("could not contact GuildSync auth server at %s: %w", cfg.AuthServerURL, err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	var tokenResp desktopTokenResponse
	if err := json.Unmarshal(respBody, &tokenResp); err != nil {
		return GuildSyncSession{}, fmt.Errorf("GuildSync auth server returned an invalid response: %s", string(respBody))
	}

	if resp.StatusCode < 200 || resp.StatusCode > 299 || !tokenResp.OK {
		if tokenResp.Error != "" {
			return GuildSyncSession{}, errors.New(tokenResp.Error)
		}

		if tokenResp.Message != "" {
			return GuildSyncSession{}, errors.New(tokenResp.Message)
		}

		return GuildSyncSession{}, fmt.Errorf("GuildSync auth server rejected login: %s", string(respBody))
	}

	session := GuildSyncSession{
		LoggedIn:      tokenResp.Allowed && tokenResp.Token != "",
		Allowed:       tokenResp.Allowed,
		Token:         tokenResp.Token,
		ExpiresAt:     tokenResp.ExpiresAt,
		User:          tokenResp.User,
		SocketURL:     cfg.SocketURL,
		AuthServerURL: cfg.AuthServerURL,
		StatusMessage: tokenResp.Message,
	}

	if session.StatusMessage == "" && session.Allowed {
		session.StatusMessage = "Logged in and authorized."
	}

	return session, nil
}

func LoadGuildSyncClientConfig() (GuildSyncClientConfig, error) {
	// 1. Start with safe built-in defaults.
	cfg := defaultGuildSyncClientConfig

	// 2. Environment variables may override the built-in defaults.
	// These are useful while developing.
	if value := strings.TrimSpace(os.Getenv("GUILDSYNC_DISCORD_CLIENT_ID")); value != "" {
		cfg.DiscordClientID = value
	}

	if value := strings.TrimSpace(os.Getenv("GUILDSYNC_DISCORD_REDIRECT_URI")); value != "" {
		cfg.RedirectURI = value
	}

	if value := strings.TrimSpace(os.Getenv("GUILDSYNC_AUTH_SERVER_URL")); value != "" {
		cfg.AuthServerURL = value
	}

	if value := strings.TrimSpace(os.Getenv("GUILDSYNC_SOCKET_URL")); value != "" {
		cfg.SocketURL = value
	}

	// 3. The optional config file may override both defaults and env vars.
	// This file is no longer required, but it is still useful for testing.
	fileCfg, err := loadGuildSyncClientConfigFile()
	if err == nil {
		if strings.TrimSpace(fileCfg.DiscordClientID) != "" {
			cfg.DiscordClientID = strings.TrimSpace(fileCfg.DiscordClientID)
		}

		if strings.TrimSpace(fileCfg.RedirectURI) != "" {
			cfg.RedirectURI = strings.TrimSpace(fileCfg.RedirectURI)
		}

		if strings.TrimSpace(fileCfg.AuthServerURL) != "" {
			cfg.AuthServerURL = strings.TrimSpace(fileCfg.AuthServerURL)
		}

		if strings.TrimSpace(fileCfg.SocketURL) != "" {
			cfg.SocketURL = strings.TrimSpace(fileCfg.SocketURL)
		}
	}

	cfg.DiscordClientID = strings.TrimSpace(cfg.DiscordClientID)
	cfg.RedirectURI = strings.TrimSpace(cfg.RedirectURI)
	cfg.AuthServerURL = strings.TrimSpace(cfg.AuthServerURL)
	cfg.SocketURL = strings.TrimSpace(cfg.SocketURL)

	if cfg.SocketURL == "" {
		cfg.SocketURL = cfg.AuthServerURL
	}

	if cfg.DiscordClientID == "" || cfg.DiscordClientID == "PASTE_YOUR_DISCORD_CLIENT_ID_HERE" {
		return cfg, errors.New("missing Discord client ID. Set it in defaultGuildSyncClientConfig, GUILDSYNC_DISCORD_CLIENT_ID, or guildsync-client.json")
	}

	if cfg.RedirectURI == "" {
		return cfg, errors.New("missing Discord redirect URI")
	}

	if cfg.AuthServerURL == "" {
		return cfg, errors.New("missing GuildSync auth server URL")
	}

	if cfg.SocketURL == "" {
		return cfg, errors.New("missing GuildSync socket URL")
	}

	if _, err := url.ParseRequestURI(cfg.RedirectURI); err != nil {
		return cfg, fmt.Errorf("invalid redirect URI: %w", err)
	}

	if _, err := url.ParseRequestURI(cfg.AuthServerURL); err != nil {
		return cfg, fmt.Errorf("invalid GuildSync auth server URL: %w", err)
	}

	if _, err := url.ParseRequestURI(cfg.SocketURL); err != nil {
		return cfg, fmt.Errorf("invalid GuildSync socket URL: %w", err)
	}

	return cfg, nil
}

func loadGuildSyncClientConfigFile() (GuildSyncClientConfig, error) {
	path, err := getGuildSyncClientConfigPath()
	if err != nil {
		return GuildSyncClientConfig{}, err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return GuildSyncClientConfig{}, err
	}

	var cfg GuildSyncClientConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return GuildSyncClientConfig{}, err
	}

	return cfg, nil
}

func getGuildSyncClientConfigPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}

	return filepath.Join(configDir, "GuildSync", "guildsync-client.json"), nil
}

func getGuildSyncSessionPath() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}

	return filepath.Join(configDir, "GuildSync", "guildsync-session.json"), nil
}

func saveGuildSyncSession(session GuildSyncSession) error {
	path, err := getGuildSyncSessionPath()
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(session, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0600)
}

func loadGuildSyncSession() (GuildSyncSession, error) {
	path, err := getGuildSyncSessionPath()
	if err != nil {
		return GuildSyncSession{}, err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return GuildSyncSession{}, err
	}

	var session GuildSyncSession
	if err := json.Unmarshal(data, &session); err != nil {
		return GuildSyncSession{}, err
	}

	return session, nil
}

func DeleteGuildSyncSession() error {
	path, err := getGuildSyncSessionPath()
	if err != nil {
		return err
	}

	_ = os.Remove(path)
	return nil
}

func randomState() (string, error) {
	buf := make([]byte, 32)

	if _, err := rand.Read(buf); err != nil {
		return "", err
	}

	return base64.RawURLEncoding.EncodeToString(buf), nil
}

func htmlResultPage(title string, message string, subMessage string, pageType string) string {
	accentColor := "#22c55e"
	badgeText := "Authenticated"

	if pageType == "pending" {
		accentColor = "#f59e0b"
		badgeText = "Pending Approval"
	}

	if pageType == "error" {
		accentColor = "#ef4444"
		badgeText = "Login Issue"
	}

	return `<!doctype html>
<html>
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>` + htmlEscape(title) + `</title>
</head>
<body style="margin:0;min-height:100vh;font-family:Segoe UI,Arial,sans-serif;background:linear-gradient(180deg,#0F172A 0%,#111C3D 100%);color:#E5E7EB;display:flex;align-items:center;justify-content:center;">
	<div style="width:min(560px,calc(100vw - 40px));background:rgba(15,23,42,0.82);border:1px solid rgba(255,255,255,0.14);border-radius:24px;box-shadow:0 24px 80px rgba(0,0,0,0.45);padding:42px 38px;text-align:center;">
		<div style="width:72px;height:72px;border-radius:999px;margin:0 auto 24px auto;background:` + accentColor + `22;border:1px solid ` + accentColor + `66;display:flex;align-items:center;justify-content:center;box-shadow:0 0 30px ` + accentColor + `33;">
			<div style="width:28px;height:28px;border-radius:999px;background:` + accentColor + `;box-shadow:0 0 18px ` + accentColor + `99;"></div>
		</div>

		<div style="display:inline-flex;align-items:center;justify-content:center;padding:7px 13px;border-radius:999px;background:` + accentColor + `22;color:` + accentColor + `;font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:18px;">
			` + htmlEscape(badgeText) + `
		</div>

		<h1 style="margin:0 0 14px 0;font-size:30px;line-height:1.2;font-weight:700;color:#F8FAFC;">
			` + htmlEscape(title) + `
		</h1>

		<p style="margin:0 auto 18px auto;max-width:460px;font-size:16px;line-height:1.55;color:#CBD5E1;">
			` + htmlEscape(message) + `
		</p>

		<p style="margin:0 auto;max-width:460px;font-size:14px;line-height:1.5;color:#94A3B8;">
			` + htmlEscape(subMessage) + `
		</p>
	</div>
</body>
</html>`
}

func htmlEscape(value string) string {
	value = strings.ReplaceAll(value, "&", "&amp;")
	value = strings.ReplaceAll(value, "<", "&lt;")
	value = strings.ReplaceAll(value, ">", "&gt;")
	value = strings.ReplaceAll(value, `"`, "&quot;")

	return value
}

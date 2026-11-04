package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestVerifiedSessionUsesEffectiveProfileAndKeepsActorToken(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/auth/session" || r.Header.Get("Authorization") != "Bearer actor-token" {
			t.Errorf("unexpected verification request: %s", r.URL.Path)
		}
		w.Write([]byte(`{"ok":true,"user":{"discord_user_id":"target","username":"viewer","global_name":"Target Viewer","display_name":"Target","avatar_url":"https://example.com/avatar","role":"viewer","actual_role":"viewer","user_switch":{"active":true,"revision":7,"epoch":"server-epoch","can_switch":true,"actor_id":"actor","actor_name":"Admin","target_id":"target","target_name":"Target"}}}`))
	}))
	defer server.Close()
	saved := GuildSyncSession{LoggedIn: true, Allowed: true, Token: "actor-token", AuthServerURL: server.URL, User: GuildSyncUser{DiscordUserID: "actor", Role: "Admin"}}
	configDir := t.TempDir()
	t.Setenv("APPDATA", configDir)
	t.Setenv("XDG_CONFIG_HOME", configDir)
	// macOS UserConfigDir resolves the test user home rather than APPDATA/XDG.
	t.Setenv("HOME", configDir)
	if err := saveGuildSyncSession(saved); err != nil {
		t.Fatal(err)
	}
	got, err := (&App{}).GetGuildSyncSession()
	if err != nil {
		t.Fatal(err)
	}
	if !got.LoggedIn || !got.Allowed || got.User.DiscordUserID != "target" || got.User.Role != "viewer" || got.User.ActualRole != "viewer" || got.User.GlobalName != "Target Viewer" || got.User.AvatarURL == "" {
		t.Fatalf("effective profile missing: %+v", got.User)
	}
	if got.User.UserSwitch == nil || !got.User.UserSwitch.Active || got.User.UserSwitch.ActorID != "actor" || got.User.UserSwitch.TargetID != "target" || got.User.UserSwitch.Revision != 7 || got.User.UserSwitch.Epoch != "server-epoch" || !got.User.UserSwitch.CanSwitch {
		t.Fatalf("switch metadata missing: %+v", got.User.UserSwitch)
	}
	if got.Token != saved.Token || saved.User.DiscordUserID != "actor" {
		t.Fatal("actor session changed")
	}
	persisted, err := loadGuildSyncSession()
	if err != nil || persisted.Token != saved.Token || persisted.User.DiscordUserID != "actor" {
		t.Fatal("verification rewrote persisted actor session")
	}
}

func TestSessionVerificationFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		status     int
	}{
		{"unavailable", `{}`, 503}, {"malformed", `{`, 200},
		{"missing profile", `{"ok":true}`, 200},
		{"rejected", `{"ok":false,"user":{"discord_user_id":"actor","role":"Admin"}}`, 200},
		{"missing role", `{"ok":true,"user":{"discord_user_id":"actor"}}`, 200},
		{"trailing data", `{"ok":true,"user":{"discord_user_id":"actor","role":"Admin"}} {}`, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(tc.status); w.Write([]byte(tc.body)) }))
			defer server.Close()
			assertSessionUnverified(t, verifyGuildSyncSession(GuildSyncSession{Token: "actor-token", LoggedIn: true, Allowed: true, AuthServerURL: server.URL, User: GuildSyncUser{Role: "Admin"}}))
		})
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	server.Close()
	assertSessionUnverified(t, verifyGuildSyncSession(GuildSyncSession{Token: "actor-token", LoggedIn: true, Allowed: true, AuthServerURL: server.URL, User: GuildSyncUser{Role: "Admin"}}))
}

func assertSessionUnverified(t *testing.T, session GuildSyncSession) {
	t.Helper()
	if session.LoggedIn || session.Allowed || session.Token != "" || session.User.Role != "" || session.StatusMessage == "" {
		t.Fatalf("stale session exposed: %+v", session.User)
	}
}

func TestSessionVerificationSupportsOlderNormalProfile(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"ok":true,"user":{"discord_user_id":"actor","username":"admin","role":"Admin"}}`))
	}))
	defer server.Close()
	got := verifyGuildSyncSession(GuildSyncSession{Token: "actor-token", AuthServerURL: server.URL})
	if !got.LoggedIn || got.User.UserSwitch != nil || got.User.ActualRole != "" || got.Token != "actor-token" {
		t.Fatalf("older profile rejected: %+v", got.User)
	}
}

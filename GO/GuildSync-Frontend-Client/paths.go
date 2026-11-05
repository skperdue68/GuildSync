package main

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

type GuildSyncPaths struct {
	SavedVarsDir        string                        `json:"savedVarsDir"`
	SavedVarsWatchFiles []GuildSyncSavedVarsWatchFile `json:"savedVarsWatchFiles"`
}

type GuildSyncSavedVarsWatchFile struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	FileName string `json:"fileName"`
	FilePath string `json:"filePath"`
	Enabled  bool   `json:"enabled"`
}

func findEnvSearchDirs() []string {
	seen := map[string]bool{}
	dirs := []string{}

	addDir := func(dir string) {
		dir = strings.TrimSpace(dir)
		if dir == "" {
			return
		}

		cleanDir, err := filepath.Abs(dir)
		if err == nil {
			dir = cleanDir
		}

		key := strings.ToLower(filepath.Clean(dir))
		if seen[key] {
			return
		}

		seen[key] = true
		dirs = append(dirs, dir)
	}

	// Release/build behavior: check beside the executable first.
	if exePath, err := os.Executable(); err == nil {
		addDir(filepath.Dir(exePath))
	}

	// Development behavior: check the current working directory.
	if workingDir, err := os.Getwd(); err == nil {
		addDir(workingDir)
	}

	return dirs
}

func findEnvFiles() []string {
	files := []string{}

	// Load hidden/default values first, then the visible user-editable settings.
	// Later files may override earlier file-provided values, but real OS
	// environment variables still win over both files.
	for _, dir := range findEnvSearchDirs() {
		for _, fileName := range []string{".env", "GuildSyncSettings.txt"} {
			path := filepath.Join(dir, fileName)
			if _, err := os.Stat(path); err == nil {
				files = append(files, path)
			}
		}
	}

	return files
}

func readEnvFile(envPath string, protectedKeys map[string]bool) {
	file, err := os.Open(envPath)
	if err != nil {
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())

		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		equalsIndex := strings.Index(line, "=")
		if equalsIndex == -1 {
			continue
		}

		key := strings.TrimSpace(line[:equalsIndex])
		value := strings.TrimSpace(line[equalsIndex+1:])

		if key == "" {
			continue
		}

		// Allow quoted values.
		if len(value) >= 2 {
			if (strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`)) ||
				(strings.HasPrefix(value, `'`) && strings.HasSuffix(value, `'`)) {
				value = value[1 : len(value)-1]
			}
		}

		// Protect variables that came from the real OS environment before files
		// were loaded. File values may override earlier file values, which lets
		// GuildSyncSettings.txt override .env.
		if !protectedKeys[key] {
			os.Setenv(key, value)
		}
	}
}

func loadOptionalEnvFile() {
	protectedKeys := map[string]bool{}
	for _, item := range os.Environ() {
		if equalsIndex := strings.Index(item, "="); equalsIndex > 0 {
			protectedKeys[item[:equalsIndex]] = true
		}
	}

	for _, envPath := range findEnvFiles() {
		readEnvFile(envPath, protectedKeys)
	}
}

func resolvePathFromEnv(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}

	homeDir, err := os.UserHomeDir()
	if err == nil {
		if value == "~" {
			return homeDir
		}

		if strings.HasPrefix(value, "~/") || strings.HasPrefix(value, `~\`) {
			return filepath.Join(homeDir, value[2:])
		}
	}

	return value
}

func getDefaultSavedVarsDir() string {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return ""
	}

	return filepath.Join(
		homeDir,
		"Documents",
		"Elder Scrolls Online",
		"live",
		"SavedVariables",
	)
}

func getSavedVarsDir() string {
	if envDir := resolvePathFromEnv(os.Getenv("SAVED_VARS_DIR")); envDir != "" {
		return envDir
	}

	return getDefaultSavedVarsDir()
}

func getSavedVarsFileNameFromEnv(envKey string, defaultFileName string) string {
	fileName := strings.TrimSpace(os.Getenv(envKey))
	if fileName == "" {
		fileName = defaultFileName
	}

	return filepath.Base(fileName)
}

func getSavedVarsWatchFiles() []GuildSyncSavedVarsWatchFile {
	dir := getSavedVarsDir()

	watchFiles := []GuildSyncSavedVarsWatchFile{
		{
			Key:      "banking",
			Label:    "Banking",
			FileName: getSavedVarsFileNameFromEnv("SAVED_VARS_BANKING_FILE_NAME", "GuildSyncBanking.lua"),
		},
		{
			Key:      "roster",
			Label:    "Roster",
			FileName: getSavedVarsFileNameFromEnv("SAVED_VARS_ROSTER_FILE_NAME", "GuildSyncRoster.lua"),
		},
		{
			Key:      "applications",
			Label:    "Applications",
			FileName: getSavedVarsFileNameFromEnv("SAVED_VARS_APPLICATIONS_FILE_NAME", "GuildSyncApplications.lua"),
		},
		// Item Share is watched for change detection only. It has no upload
		// handler yet, so a detected change is logged without collecting data.
		{
			Key:      "itemshare",
			Label:    "Item Share",
			FileName: getSavedVarsFileNameFromEnv("SAVED_VARS_ITEMSHARE_FILE_NAME", "ItemShareSavedVariables.lua"),
		},
	}

	settings := loadFileWatchSettings()

	for i := range watchFiles {
		watchFiles[i].FilePath = filepath.Join(dir, watchFiles[i].FileName)
		watchFiles[i].Enabled = !settings.DisabledFiles[strings.ToLower(strings.TrimSpace(watchFiles[i].Key))]
	}

	return watchFiles
}

func getSavedVarsWatchFileByKey(key string) GuildSyncSavedVarsWatchFile {
	cleanKey := strings.ToLower(strings.TrimSpace(key))

	for _, watchFile := range getSavedVarsWatchFiles() {
		if strings.ToLower(strings.TrimSpace(watchFile.Key)) == cleanKey {
			return watchFile
		}
	}

	return GuildSyncSavedVarsWatchFile{}
}

func (a *App) GetResolvedPaths() GuildSyncPaths {
	return GuildSyncPaths{
		SavedVarsDir:        getSavedVarsDir(),
		SavedVarsWatchFiles: getSavedVarsWatchFiles(),
	}
}

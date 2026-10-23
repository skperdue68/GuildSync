package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type GuildSyncRosterDataResult struct {
	OK       bool                   `json:"ok"`
	Message  string                 `json:"message"`
	Key      string                 `json:"key"`
	Label    string                 `json:"label"`
	FileName string                 `json:"fileName"`
	FilePath string                 `json:"filePath"`
	Data     map[string]interface{} `json:"data,omitempty"`
}

func (a *App) CollectGuildSyncRosterData(event GuildSyncSavedVarsFileModifiedEvent) GuildSyncRosterDataResult {
	watchFile := getSavedVarsWatchFileByKey("roster")

	fileName := strings.TrimSpace(event.FileName)
	if fileName == "" {
		fileName = watchFile.FileName
	}
	fileName = filepath.Base(fileName)

	filePath := strings.TrimSpace(event.FilePath)
	if filePath == "" {
		filePath = filepath.Join(getSavedVarsDir(), fileName)
	}

	baseResult := GuildSyncRosterDataResult{
		OK:       false,
		Key:      "roster",
		Label:    watchFile.Label,
		FileName: fileName,
		FilePath: filePath,
	}

	info, err := os.Stat(filePath)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Roster SavedVariables file could not be read: %v", err)
		return baseResult
	}

	if info.IsDir() {
		baseResult.Message = fmt.Sprintf("Roster SavedVariables path is a directory, not a file: %s", filePath)
		return baseResult
	}

	originalBytes, err := os.ReadFile(filePath)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Roster SavedVariables file could not be read: %v", err)
		return baseResult
	}

	originalText := string(originalBytes)

	extracted, err := extractFirstAvailableLuaTable(originalText, getRosterSavedVarsTableNames())
	if err != nil {
		baseResult.Message = err.Error()
		return baseResult
	}

	parsed, err := parseEsoLuaTable(extracted.tableText)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Roster SavedVariables file could not be parsed: %v", err)
		return baseResult
	}

	parsedMap, ok := parsed.(map[string]interface{})
	if !ok {
		baseResult.Message = fmt.Sprintf("%s did not parse as a Lua table object.", extracted.tableName)
		return baseResult
	}

	defaultSection, ok := getLuaMap(parsedMap["Default"])
	if !ok {
		baseResult.Message = fmt.Sprintf("Could not find %s.Default", extracted.tableName)
		return baseResult
	}

	accountName := getFirstEsoAccountName(defaultSection)
	if accountName == "" {
		baseResult.Message = fmt.Sprintf("Could not find an ESO account name under %s.Default", extracted.tableName)
		return baseResult
	}

	accountSection, ok := getLuaMap(defaultSection[accountName])
	if !ok {
		baseResult.Message = fmt.Sprintf("Could not find %s.Default[\"%s\"]", extracted.tableName, accountName)
		return baseResult
	}

	accountWide, ok := getLuaMap(accountSection["$AccountWide"])
	if !ok {
		baseResult.Message = fmt.Sprintf("Could not find %s.Default[\"%s\"][\"$AccountWide\"]", extracted.tableName, accountName)
		return baseResult
	}

	guildList, hasGuildList := getLuaMap(accountWide["guildList"])
	rosterEvents, hasRosterEvents := getLuaMap(accountWide["rosterEvents"])

	guildListMemberCount := 0
	if hasGuildList {
		if members, ok := getLuaMap(guildList["guildListMembers"]); ok {
			guildListMemberCount = len(members)
		}
	}

	rosterEventCount := 0
	if hasRosterEvents {
		rosterEventCount = len(rosterEvents)
	}

	if guildListMemberCount == 0 && rosterEventCount == 0 {
		baseResult.Message = fmt.Sprintf("No roster guildlist or stream entries found in %s.", fileName)
		return baseResult
	}

	data := map[string]interface{}{
		"table_name":   extracted.tableName,
		"account_name": accountName,
		"guildId":      accountWide["guildId"],
		"guildName":    accountWide["guildName"],
		"section_counts": map[string]interface{}{
			"guildListMembers": guildListMemberCount,
			"rosterEvents":     rosterEventCount,
		},
	}

	if hasGuildList && guildListMemberCount > 0 {
		data["guildList"] = guildList
	}

	if hasRosterEvents && rosterEventCount > 0 {
		data["rosterEvents"] = rosterEvents
	}

	baseResult.OK = true
	baseResult.Message = fmt.Sprintf("Collected roster data from %s. Guild list members: %d. Stream events: %d. SavedVariables will be cleared after backend confirmation.", fileName, guildListMemberCount, rosterEventCount)
	baseResult.Data = data

	return baseResult
}

func (a *App) CommitGuildSyncRosterData(filePath string, fileName string) GuildSyncRosterDataResult {
	watchFile := getSavedVarsWatchFileByKey("roster")

	fileName = filepath.Base(strings.TrimSpace(fileName))
	if fileName == "." || fileName == string(filepath.Separator) || fileName == "" {
		fileName = watchFile.FileName
	}

	filePath = strings.TrimSpace(filePath)
	if filePath == "" {
		filePath = filepath.Join(getSavedVarsDir(), fileName)
	}

	baseResult := GuildSyncRosterDataResult{
		OK:       false,
		Key:      "roster",
		Label:    watchFile.Label,
		FileName: fileName,
		FilePath: filePath,
	}

	info, err := os.Stat(filePath)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Roster SavedVariables file could not be read for cleanup: %v", err)
		return baseResult
	}

	if info.IsDir() {
		baseResult.Message = fmt.Sprintf("Roster SavedVariables cleanup path is a directory, not a file: %s", filePath)
		return baseResult
	}

	originalBytes, err := os.ReadFile(filePath)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Roster SavedVariables file could not be read for cleanup: %v", err)
		return baseResult
	}

	originalText := string(originalBytes)

	backupPath, err := createGuildSyncSavedVarsBackup(filePath, originalBytes)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Roster backend ACK received, but backup file could not be written: %v", err)
		return baseResult
	}

	cleanedText, _ := replaceLuaBracketSubtable(originalText, "guildList", renderEmptyGuildListSection())
	cleanedText, _ = replaceLuaBracketSubtable(cleanedText, "rosterEvents", renderEmptyLuaTableSection("rosterEvents"))

	if err := os.WriteFile(filePath, []byte(cleanedText), info.Mode().Perm()); err != nil {
		baseResult.Message = fmt.Sprintf("Roster backend ACK received, but SavedVariables file could not be cleared: %v", err)
		return baseResult
	}

	baseResult.OK = true
	baseResult.Message = fmt.Sprintf("Backend confirmed roster data. Cleared guildList and rosterEvents from %s.", fileName)
	baseResult.Data = map[string]interface{}{
		"backup_path": backupPath,
	}

	return baseResult
}

func getRosterSavedVarsTableNames() []string {
	candidates := []string{}

	if envTableName := strings.TrimSpace(os.Getenv("SAVED_VARS_ROSTER_TABLE_NAME")); envTableName != "" {
		candidates = append(candidates, envTableName)
	}

	candidates = append(candidates, "GuildSyncRoster")

	seen := map[string]bool{}
	cleaned := []string{}

	for _, candidate := range candidates {
		candidate = strings.TrimSpace(candidate)
		if candidate == "" || !luaIdentifierPattern.MatchString(candidate) {
			continue
		}

		lower := strings.ToLower(candidate)
		if seen[lower] {
			continue
		}

		seen[lower] = true
		cleaned = append(cleaned, candidate)
	}

	return cleaned
}

func replaceLuaBracketSubtable(text string, key string, replacement string) (string, bool) {
	pattern := fmt.Sprintf("[\"%s\"]", luaString(key))
	keyIndex := strings.Index(text, pattern)
	if keyIndex == -1 {
		return text, false
	}

	equalsIndex := strings.Index(text[keyIndex+len(pattern):], "=")
	if equalsIndex == -1 {
		return text, false
	}
	equalsIndex = keyIndex + len(pattern) + equalsIndex

	openBraceRelative := strings.Index(text[equalsIndex:], "{")
	if openBraceRelative == -1 {
		return text, false
	}
	openBraceIndex := equalsIndex + openBraceRelative

	closeBraceIndex, ok := findMatchingLuaBrace(text, openBraceIndex)
	if !ok {
		return text, false
	}

	lineStart := strings.LastIndex(text[:keyIndex], "\n")
	if lineStart == -1 {
		lineStart = 0
	} else {
		lineStart += 1
	}

	indent := text[lineStart:keyIndex]
	indentedReplacement := indentLuaReplacement(replacement, indent)

	return text[:keyIndex] + indentedReplacement + text[closeBraceIndex+1:], true
}

func findMatchingLuaBrace(text string, openBraceIndex int) (int, bool) {
	depth := 0
	inString := false
	escaped := false

	for i := openBraceIndex; i < len(text); i++ {
		char := text[i]

		if inString {
			if escaped {
				escaped = false
			} else if char == '\\' {
				escaped = true
			} else if char == '"' {
				inString = false
			}
			continue
		}

		if char == '"' {
			inString = true
			continue
		}

		if char == '{' {
			depth++
		} else if char == '}' {
			depth--
		}

		if depth == 0 {
			return i, true
		}
	}

	return -1, false
}

func renderEmptyGuildListSection() string {
	return "[\"guildList\"] = \n{\n\t[\"listTimestamp\"] = nil,\n\t[\"guildListMembers\"] = \n\t{\n\t},\n}"
}

func renderEmptyLuaTableSection(key string) string {
	return fmt.Sprintf("[\"%s\"] = \n{\n}", luaString(key))
}

func indentLuaReplacement(replacement string, indent string) string {
	lines := strings.Split(replacement, "\n")
	for i := range lines {
		if i == 0 {
			continue
		}
		lines[i] = indent + lines[i]
	}
	return strings.Join(lines, "\n")
}

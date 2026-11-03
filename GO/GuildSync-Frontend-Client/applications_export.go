package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type GuildSyncApplicationsDataResult struct {
	OK       bool                   `json:"ok"`
	Message  string                 `json:"message"`
	Key      string                 `json:"key"`
	Label    string                 `json:"label"`
	FileName string                 `json:"fileName"`
	FilePath string                 `json:"filePath"`
	Data     map[string]interface{} `json:"data,omitempty"`
}

// CollectGuildSyncApplicationsData is called by the frontend after the
// GuildSyncApplications SavedVariables file changes. It reads every entry under
// ["records"], converts the data to JSON-ready values, and leaves the file
// untouched until the backend/Discord bot confirms receipt.
func (a *App) CollectGuildSyncApplicationsData(event GuildSyncSavedVarsFileModifiedEvent) GuildSyncApplicationsDataResult {
	watchFile := getSavedVarsWatchFileByKey("applications")

	fileName := strings.TrimSpace(event.FileName)
	if fileName == "" {
		fileName = watchFile.FileName
	}
	fileName = filepath.Base(fileName)

	filePath := strings.TrimSpace(event.FilePath)
	if filePath == "" {
		filePath = filepath.Join(getSavedVarsDir(), fileName)
	}

	baseResult := GuildSyncApplicationsDataResult{
		OK:       false,
		Key:      "applications",
		Label:    watchFile.Label,
		FileName: fileName,
		FilePath: filePath,
	}

	info, err := os.Stat(filePath)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Applications SavedVariables file could not be read: %v", err)
		return baseResult
	}

	if info.IsDir() {
		baseResult.Message = fmt.Sprintf("Applications SavedVariables path is a directory, not a file: %s", filePath)
		return baseResult
	}

	originalBytes, err := os.ReadFile(filePath)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Applications SavedVariables file could not be read: %v", err)
		return baseResult
	}

	originalText := string(originalBytes)

	extracted, err := extractFirstAvailableLuaTable(originalText, getApplicationsSavedVarsTableNames())
	if err != nil {
		baseResult.Message = err.Error()
		return baseResult
	}

	parsed, err := parseEsoLuaTable(extracted.tableText)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Applications SavedVariables file could not be parsed: %v", err)
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

	recordsMap, ok := getLuaMap(accountWide["records"])
	if !ok || len(recordsMap) == 0 {
		baseResult.Message = fmt.Sprintf("No application records found in %s.", fileName)
		return baseResult
	}

	records := normalizeApplicationsRecords(recordsMap)
	if len(records) == 0 {
		baseResult.Message = fmt.Sprintf("No usable application records found in %s.", fileName)
		return baseResult
	}

	baseResult.OK = true
	baseResult.Message = fmt.Sprintf("Collected %d application record%s from %s. SavedVariables will be cleared after backend confirmation.", len(records), pluralS(len(records)), fileName)
	baseResult.Data = map[string]interface{}{
		"table_name":    extracted.tableName,
		"account_name":  accountName,
		"records":       records,
		"records_count": len(records),
		"snapshot_hash": fmt.Sprintf("%x", sha256.Sum256(originalBytes)),
	}

	return baseResult
}

// CommitGuildSyncApplicationsData clears only the exported ["records"] table
// after the backend/Discord bot acknowledges receipt. A backup copy is written
// first so application data is not silently lost.
func (a *App) CommitGuildSyncApplicationsData(filePath string, fileName string, snapshotHash string) GuildSyncApplicationsDataResult {
	watchFile := getSavedVarsWatchFileByKey("applications")

	fileName = filepath.Base(strings.TrimSpace(fileName))
	if fileName == "." || fileName == string(filepath.Separator) || fileName == "" {
		fileName = watchFile.FileName
	}

	filePath = strings.TrimSpace(filePath)
	if filePath == "" {
		filePath = filepath.Join(getSavedVarsDir(), fileName)
	}

	baseResult := GuildSyncApplicationsDataResult{
		OK:       false,
		Key:      "applications",
		Label:    watchFile.Label,
		FileName: fileName,
		FilePath: filePath,
	}

	info, err := os.Stat(filePath)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Applications SavedVariables file could not be read for cleanup: %v", err)
		return baseResult
	}

	if info.IsDir() {
		baseResult.Message = fmt.Sprintf("Applications SavedVariables cleanup path is a directory, not a file: %s", filePath)
		return baseResult
	}

	originalBytes, err := os.ReadFile(filePath)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Applications SavedVariables file could not be read for cleanup: %v", err)
		return baseResult
	}

	// Never clear a newer ESO save that was not part of the acknowledged batch.
	if snapshotHash == "" || snapshotHash != fmt.Sprintf("%x", sha256.Sum256(originalBytes)) {
		baseResult.Data = map[string]interface{}{"cleanup_deferred": true}
		baseResult.Message = "Applications SavedVariables changed after collection. Pending records were preserved; collect and send them again."
		return baseResult
	}

	originalText := string(originalBytes)

	backupPath, err := createGuildSyncSavedVarsBackup(filePath, originalBytes)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Applications backend ACK received, but backup file could not be written: %v", err)
		return baseResult
	}

	cleanedText, replaced := replaceLuaBracketSubtable(originalText, "records", renderEmptyLuaTableSection("records"))
	if !replaced {
		baseResult.Message = "Applications backend ACK received, but the records table could not be found for cleanup."
		return baseResult
	}

	if err := os.WriteFile(filePath, []byte(cleanedText), info.Mode().Perm()); err != nil {
		baseResult.Message = fmt.Sprintf("Applications backend ACK received, but SavedVariables file could not be cleared: %v", err)
		return baseResult
	}

	baseResult.OK = true
	baseResult.Message = fmt.Sprintf("Backend confirmed application data. Cleared records from %s.", fileName)
	baseResult.Data = map[string]interface{}{
		"backup_path": backupPath,
	}

	return baseResult
}

func getApplicationsSavedVarsTableNames() []string {
	candidates := []string{}

	if envTableName := strings.TrimSpace(os.Getenv("SAVED_VARS_APPLICATIONS_TABLE_NAME")); envTableName != "" {
		candidates = append(candidates, envTableName)
	}

	candidates = append(candidates, "GuildSyncApplications")

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

func normalizeApplicationsRecords(recordsMap map[string]interface{}) []interface{} {
	keys := make([]string, 0, len(recordsMap))
	for key := range recordsMap {
		keys = append(keys, key)
	}

	sort.SliceStable(keys, func(i int, j int) bool {
		leftNumber, leftIsNumber := parseSortableInt(keys[i])
		rightNumber, rightIsNumber := parseSortableInt(keys[j])
		if leftIsNumber && rightIsNumber {
			return leftNumber < rightNumber
		}
		if leftIsNumber != rightIsNumber {
			return leftIsNumber
		}
		return strings.ToLower(keys[i]) < strings.ToLower(keys[j])
	})

	records := make([]interface{}, 0, len(keys))
	for _, key := range keys {
		value := recordsMap[key]
		if recordMap, ok := getLuaMap(value); ok {
			copied := map[string]interface{}{}
			for fieldKey, fieldValue := range recordMap {
				copied[fieldKey] = fieldValue
			}
			copied["recordKey"] = key
			records = append(records, copied)
			continue
		}

		records = append(records, map[string]interface{}{
			"recordKey": key,
			"value":     value,
		})
	}

	return records
}

func parseSortableInt(value string) (int, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, false
	}

	var number int
	_, err := fmt.Sscanf(trimmed, "%d", &number)
	if err != nil {
		return 0, false
	}

	return number, true
}

func pluralS(count int) string {
	if count == 1 {
		return ""
	}
	return "s"
}

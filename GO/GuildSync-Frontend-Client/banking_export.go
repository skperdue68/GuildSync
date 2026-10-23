package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

type GuildSyncBankingDataResult struct {
	OK       bool                   `json:"ok"`
	Message  string                 `json:"message"`
	Key      string                 `json:"key"`
	Label    string                 `json:"label"`
	FileName string                 `json:"fileName"`
	FilePath string                 `json:"filePath"`
	Data     map[string]interface{} `json:"data,omitempty"`
}

type extractedLuaTable struct {
	tableText       string
	assignmentStart int
	tableStart      int
	tableEnd        int
	tableName       string
}

type esoLuaTableParser struct {
	text string
	i    int
}

var luaIdentifierPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// CollectGuildSyncBankingData is called by the frontend after the Banking
// SavedVariables file changes. It reads the configured banking SavedVariables
// file and extracts the banking entries as JSON-ready data. It intentionally
// does not clear the SavedVariables file. The frontend calls
// CommitGuildSyncBankingData only after the backend confirms receipt.
func (a *App) CollectGuildSyncBankingData(event GuildSyncSavedVarsFileModifiedEvent) GuildSyncBankingDataResult {
	watchFile := getSavedVarsWatchFileByKey("banking")

	fileName := strings.TrimSpace(event.FileName)
	if fileName == "" {
		fileName = watchFile.FileName
	}
	fileName = filepath.Base(fileName)

	filePath := strings.TrimSpace(event.FilePath)
	if filePath == "" {
		filePath = filepath.Join(getSavedVarsDir(), fileName)
	}

	baseResult := GuildSyncBankingDataResult{
		OK:       false,
		Key:      "banking",
		Label:    watchFile.Label,
		FileName: fileName,
		FilePath: filePath,
	}

	if strings.TrimSpace(filePath) == "" {
		baseResult.Message = "Banking SavedVariables file path could not be resolved."
		return baseResult
	}

	info, err := os.Stat(filePath)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Banking SavedVariables file could not be read: %v", err)
		return baseResult
	}

	if info.IsDir() {
		baseResult.Message = fmt.Sprintf("Banking SavedVariables path is a directory, not a file: %s", filePath)
		return baseResult
	}

	originalBytes, err := os.ReadFile(filePath)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Banking SavedVariables file could not be read: %v", err)
		return baseResult
	}

	originalText := string(originalBytes)

	extracted, err := extractFirstAvailableLuaTable(originalText, getBankingSavedVarsTableNames())
	if err != nil {
		baseResult.Message = err.Error()
		return baseResult
	}

	parsed, err := parseEsoLuaTable(extracted.tableText)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Banking SavedVariables file could not be parsed: %v", err)
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

	biweeklyEntries := asLuaArray(accountWide["biweekly"])
	monthlyEntries := asLuaArray(accountWide["monthly"])
	otherEntries := asLuaArray(accountWide["other"])

	exportedEntries := make([]interface{}, 0, len(biweeklyEntries)+len(monthlyEntries)+len(otherEntries))
	exportedEntries = append(exportedEntries, entriesWithType("biweekly", biweeklyEntries)...)
	exportedEntries = append(exportedEntries, entriesWithType("monthly", monthlyEntries)...)
	exportedEntries = append(exportedEntries, entriesWithType("other", otherEntries)...)

	if len(exportedEntries) == 0 {
		baseResult.Message = fmt.Sprintf("No banking entries found in %s.", fileName)
		return baseResult
	}

	baseResult.OK = true
	baseResult.Message = fmt.Sprintf("Collected %d banking entr%s from %s. SavedVariables will be cleared after backend confirmation.", len(exportedEntries), pluralY(len(exportedEntries)), fileName)
	baseResult.Data = map[string]interface{}{
		"table_name":    extracted.tableName,
		"account_name":  accountName,
		"guildId":       accountWide["guildId"],
		"guildName":     accountWide["guildName"],
		"entries":       exportedEntries,
		"entries_count": len(exportedEntries),
		"section_counts": map[string]interface{}{
			"biweekly": len(biweeklyEntries),
			"monthly":  len(monthlyEntries),
			"other":    len(otherEntries),
		},
	}

	return baseResult
}

// CommitGuildSyncBankingData clears exported banking entries after the backend
// confirms receipt. This keeps ESO SavedVariables data intact if Socket.IO is
// disconnected, times out, or the backend rejects the payload.
func (a *App) CommitGuildSyncBankingData(filePath string, fileName string) GuildSyncBankingDataResult {
	watchFile := getSavedVarsWatchFileByKey("banking")

	fileName = filepath.Base(strings.TrimSpace(fileName))
	if fileName == "." || fileName == string(filepath.Separator) || fileName == "" {
		fileName = watchFile.FileName
	}

	filePath = strings.TrimSpace(filePath)
	if filePath == "" {
		filePath = filepath.Join(getSavedVarsDir(), fileName)
	}

	baseResult := GuildSyncBankingDataResult{
		OK:       false,
		Key:      "banking",
		Label:    watchFile.Label,
		FileName: fileName,
		FilePath: filePath,
	}

	info, err := os.Stat(filePath)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Banking SavedVariables file could not be read for cleanup: %v", err)
		return baseResult
	}

	if info.IsDir() {
		baseResult.Message = fmt.Sprintf("Banking SavedVariables cleanup path is a directory, not a file: %s", filePath)
		return baseResult
	}

	originalBytes, err := os.ReadFile(filePath)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Banking SavedVariables file could not be read for cleanup: %v", err)
		return baseResult
	}

	originalText := string(originalBytes)

	extracted, err := extractFirstAvailableLuaTable(originalText, getBankingSavedVarsTableNames())
	if err != nil {
		baseResult.Message = err.Error()
		return baseResult
	}

	parsed, err := parseEsoLuaTable(extracted.tableText)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Banking SavedVariables file could not be parsed for cleanup: %v", err)
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

	backupPath, err := createGuildSyncSavedVarsBackup(filePath, originalBytes)
	if err != nil {
		baseResult.Message = fmt.Sprintf("Banking backend ACK received, but backup file could not be written: %v", err)
		return baseResult
	}

	// Clear only the ESO-exported banking entry sections after backend ACK.
	// Preserve desktop/addon mail coordination tables such as mailQueue, mailAck,
	// and sentMailIds so a banking upload cleanup cannot accidentally delete
	// pending deposit mail or the ESO-side duplicate-send guard.
	accountWide["other"] = []interface{}{}
	accountWide["biweekly"] = []interface{}{}
	accountWide["monthly"] = []interface{}{}

	newBankingText := renderLuaAssignment(extracted.tableName, parsedMap)
	newSavedVarsText := originalText[:extracted.assignmentStart] + newBankingText + originalText[extracted.tableEnd:]

	if err := os.WriteFile(filePath, []byte(newSavedVarsText), info.Mode().Perm()); err != nil {
		baseResult.Message = fmt.Sprintf("Banking backend ACK received, but SavedVariables file could not be cleared: %v", err)
		return baseResult
	}

	baseResult.OK = true
	baseResult.Message = fmt.Sprintf("Backend confirmed banking data. Cleared exported entries from %s.", fileName)
	baseResult.Data = map[string]interface{}{
		"table_name":   extracted.tableName,
		"account_name": accountName,
		"backup_path":  backupPath,
	}

	return baseResult
}

func getBankingSavedVarsTableNames() []string {
	candidates := []string{}

	if envTableName := strings.TrimSpace(os.Getenv("SAVED_VARS_BANKING_TABLE_NAME")); envTableName != "" {
		candidates = append(candidates, envTableName)
	}

	candidates = append(candidates, "GuildSyncBanking")

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

func extractFirstAvailableLuaTable(text string, tableNames []string) (extractedLuaTable, error) {
	missing := []string{}

	for _, tableName := range tableNames {
		extracted, err := extractLuaTableByName(text, tableName)
		if err == nil {
			return extracted, nil
		}

		missing = append(missing, tableName)
	}

	if len(missing) == 0 {
		return extractedLuaTable{}, fmt.Errorf("No valid banking SavedVariables table names were configured.")
	}

	return extractedLuaTable{}, fmt.Errorf("Could not find banking table assignment. Tried: %s", strings.Join(missing, ", "))
}

func extractLuaTableByName(text string, tableName string) (extractedLuaTable, error) {
	if !luaIdentifierPattern.MatchString(tableName) {
		return extractedLuaTable{}, fmt.Errorf("Invalid Lua table name: %s", tableName)
	}

	assignmentRegex := regexp.MustCompile(`\b` + regexp.QuoteMeta(tableName) + `\s*=\s*\{`)
	match := assignmentRegex.FindStringIndex(text)
	if match == nil {
		return extractedLuaTable{}, fmt.Errorf("Could not find table assignment: %s = {", tableName)
	}

	openBraceRelative := strings.Index(text[match[0]:match[1]], "{")
	if openBraceRelative == -1 {
		return extractedLuaTable{}, fmt.Errorf("Could not find opening brace for %s", tableName)
	}

	openBraceIndex := match[0] + openBraceRelative
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
		}
		if char == '}' {
			depth--
		}

		if depth == 0 {
			return extractedLuaTable{
				tableText:       text[openBraceIndex : i+1],
				assignmentStart: match[0],
				tableStart:      openBraceIndex,
				tableEnd:        i + 1,
				tableName:       tableName,
			}, nil
		}
	}

	return extractedLuaTable{}, fmt.Errorf("Could not find matching closing brace for %s", tableName)
}

func parseEsoLuaTable(luaTableText string) (interface{}, error) {
	parser := &esoLuaTableParser{text: luaTableText}
	value, err := parser.parseValue()
	if err != nil {
		return nil, err
	}

	parser.skipWhitespaceAndCommas()
	return value, nil
}

func (p *esoLuaTableParser) skipWhitespaceAndCommas() {
	for p.i < len(p.text) {
		char := p.text[p.i]
		if char == ',' || char == ' ' || char == '\t' || char == '\n' || char == '\r' {
			p.i++
			continue
		}
		break
	}
}

func (p *esoLuaTableParser) parseValue() (interface{}, error) {
	p.skipWhitespaceAndCommas()

	if p.i >= len(p.text) {
		return nil, fmt.Errorf("unexpected end of Lua table")
	}

	char := p.text[p.i]

	if char == '{' {
		return p.parseTable()
	}

	if char == '"' {
		return p.parseString()
	}

	if char == '-' || (char >= '0' && char <= '9') {
		return p.parseNumber()
	}

	if strings.HasPrefix(p.text[p.i:], "true") {
		p.i += 4
		return true, nil
	}

	if strings.HasPrefix(p.text[p.i:], "false") {
		p.i += 5
		return false, nil
	}

	if strings.HasPrefix(p.text[p.i:], "nil") {
		p.i += 3
		return nil, nil
	}

	return nil, fmt.Errorf("unexpected value at position %d: %s", p.i, previewLuaText(p.text[p.i:]))
}

func (p *esoLuaTableParser) parseString() (string, error) {
	p.i++ // opening quote
	var builder strings.Builder
	escaped := false

	for p.i < len(p.text) {
		char := p.text[p.i]
		p.i++

		if escaped {
			switch char {
			case 'n':
				builder.WriteByte('\n')
			case 'r':
				builder.WriteByte('\r')
			case 't':
				builder.WriteByte('\t')
			default:
				builder.WriteByte(char)
			}
			escaped = false
			continue
		}

		if char == '\\' {
			escaped = true
			continue
		}

		if char == '"' {
			return builder.String(), nil
		}

		builder.WriteByte(char)
	}

	return "", fmt.Errorf("unterminated string")
}

func (p *esoLuaTableParser) parseNumber() (interface{}, error) {
	start := p.i

	for p.i < len(p.text) {
		char := p.text[p.i]
		if char == '-' || char == '.' || (char >= '0' && char <= '9') {
			p.i++
			continue
		}
		break
	}

	raw := p.text[start:p.i]
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil {
		return nil, fmt.Errorf("invalid number: %s", raw)
	}

	return value, nil
}

func (p *esoLuaTableParser) parseKey() (interface{}, error) {
	p.skipWhitespaceAndCommas()

	if p.i >= len(p.text) || p.text[p.i] != '[' {
		return nil, fmt.Errorf("expected [ for key at position %d", p.i)
	}

	p.i++
	p.skipWhitespaceAndCommas()

	var key interface{}
	var err error

	if p.i < len(p.text) && p.text[p.i] == '"' {
		key, err = p.parseString()
	} else {
		key, err = p.parseNumber()
	}

	if err != nil {
		return nil, err
	}

	p.skipWhitespaceAndCommas()

	if p.i >= len(p.text) || p.text[p.i] != ']' {
		return nil, fmt.Errorf("expected ] at position %d", p.i)
	}

	p.i++
	p.skipWhitespaceAndCommas()

	if p.i >= len(p.text) || p.text[p.i] != '=' {
		return nil, fmt.Errorf("expected = at position %d", p.i)
	}

	p.i++
	return key, nil
}

func (p *esoLuaTableParser) parseTable() (interface{}, error) {
	if p.i >= len(p.text) || p.text[p.i] != '{' {
		return nil, fmt.Errorf("expected { at position %d", p.i)
	}

	p.i++
	entries := []struct {
		key   interface{}
		value interface{}
	}{}

	for p.i < len(p.text) {
		p.skipWhitespaceAndCommas()

		if p.i < len(p.text) && p.text[p.i] == '}' {
			p.i++
			break
		}

		key, err := p.parseKey()
		if err != nil {
			return nil, err
		}

		value, err := p.parseValue()
		if err != nil {
			return nil, err
		}

		entries = append(entries, struct {
			key   interface{}
			value interface{}
		}{key: key, value: value})
	}

	allNumeric := len(entries) > 0
	for _, entry := range entries {
		if _, ok := luaKeyToPositiveInt(entry.key); !ok {
			allNumeric = false
			break
		}
	}

	if allNumeric {
		sort.Slice(entries, func(i int, j int) bool {
			left, _ := luaKeyToPositiveInt(entries[i].key)
			right, _ := luaKeyToPositiveInt(entries[j].key)
			return left < right
		})

		array := make([]interface{}, 0, len(entries))
		for _, entry := range entries {
			array = append(array, entry.value)
		}
		return array, nil
	}

	object := map[string]interface{}{}
	for _, entry := range entries {
		object[luaKeyToString(entry.key)] = entry.value
	}

	return object, nil
}

func luaKeyToPositiveInt(value interface{}) (int, bool) {
	number, ok := value.(float64)
	if !ok {
		return 0, false
	}

	intValue := int(number)
	if number != float64(intValue) || intValue < 1 {
		return 0, false
	}

	return intValue, true
}

func luaKeyToString(value interface{}) string {
	switch typed := value.(type) {
	case string:
		return typed
	case float64:
		if typed == float64(int64(typed)) {
			return strconv.FormatInt(int64(typed), 10)
		}
		return strconv.FormatFloat(typed, 'f', -1, 64)
	default:
		return fmt.Sprint(value)
	}
}

func getLuaMap(value interface{}) (map[string]interface{}, bool) {
	result, ok := value.(map[string]interface{})
	return result, ok
}

func asLuaArray(value interface{}) []interface{} {
	if array, ok := value.([]interface{}); ok {
		return array
	}

	if object, ok := value.(map[string]interface{}); ok && len(object) == 0 {
		return []interface{}{}
	}

	return []interface{}{}
}

func entriesWithType(entryType string, entries []interface{}) []interface{} {
	result := make([]interface{}, 0, len(entries))

	for _, entry := range entries {
		if entryMap, ok := entry.(map[string]interface{}); ok {
			copied := map[string]interface{}{"type": entryType}
			for key, value := range entryMap {
				copied[key] = value
			}
			result = append(result, copied)
			continue
		}

		result = append(result, map[string]interface{}{
			"type":  entryType,
			"value": entry,
		})
	}

	return result
}

func getFirstEsoAccountName(defaultSection map[string]interface{}) string {
	keys := make([]string, 0, len(defaultSection))
	for key := range defaultSection {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	for _, key := range keys {
		if strings.HasPrefix(key, "@") {
			return key
		}
	}

	return ""
}

func renderCleanBankingSavedVarsTable(tableName string, accountName string, version interface{}) string {
	if !luaIdentifierPattern.MatchString(tableName) {
		tableName = "GuildSyncBanking"
	}

	versionValue := luaNumberForRender(version, "1")

	return fmt.Sprintf(`%s =
{
    ["Default"] =
    {
        ["%s"] =
        {
            ["$AccountWide"] =
            {
                ["version"] = %s,
%s
%s
%s
            },
        },
    },
}`, tableName, luaString(accountName), versionValue,
		renderEmptyBankingSection("other", 16),
		renderEmptyBankingSection("biweekly", 16),
		renderEmptyBankingSection("monthly", 16),
	)
}

func renderEmptyBankingSection(sectionName string, indent int) string {
	pad := strings.Repeat(" ", indent)
	return fmt.Sprintf(`%s["%s"] =
%s{ 
%s},`, pad, luaString(sectionName), pad, pad)
}

func luaString(value string) string {
	escaped := strings.ReplaceAll(value, `\`, `\\`)
	escaped = strings.ReplaceAll(escaped, "\r\n", `\n`)
	escaped = strings.ReplaceAll(escaped, "\r", `\n`)
	escaped = strings.ReplaceAll(escaped, "\n", `\n`)
	escaped = strings.ReplaceAll(escaped, `"`, `\"`)
	return escaped
}

func luaNumberForRender(value interface{}, fallback string) string {
	switch typed := value.(type) {
	case float64:
		if typed == float64(int64(typed)) {
			return strconv.FormatInt(int64(typed), 10)
		}
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case int:
		return strconv.Itoa(typed)
	case int64:
		return strconv.FormatInt(typed, 10)
	case string:
		trimmed := strings.TrimSpace(typed)
		if _, err := strconv.ParseFloat(trimmed, 64); err == nil {
			return trimmed
		}
	}

	return fallback
}

func pluralY(count int) string {
	if count == 1 {
		return "y"
	}
	return "ies"
}

func previewLuaText(text string) string {
	text = strings.ReplaceAll(text, "\n", " ")
	text = strings.ReplaceAll(text, "\r", " ")
	if len(text) > 20 {
		return text[:20]
	}
	return text
}

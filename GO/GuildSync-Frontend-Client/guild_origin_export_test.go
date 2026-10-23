package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBankingExportPreservesGuildOriginWithoutClearing(t *testing.T) {
	file := filepath.Join(t.TempDir(), "GuildSyncBanking.lua")
	text := `GuildSyncBanking = { ["Default"] = { ["@Example"] = { ["$AccountWide"] = {
		["guildId"] = "761817", ["guildName"] = "Example Guild",
		["biweekly"] = { [1] = { ["guildId"] = "761817", ["guildName"] = "Example Guild", ["eventId"] = 123, ["time"] = 1780000000, ["displayName"] = "Example", ["amount"] = 501, ["ticketAmount"] = 1 } },
		["monthly"] = {}, ["other"] = {}
	} } } }`
	if err := os.WriteFile(file, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	result := (&App{}).CollectGuildSyncBankingData(GuildSyncSavedVarsFileModifiedEvent{FileName: filepath.Base(file), FilePath: file})
	if !result.OK {
		t.Fatal(result.Message)
	}
	if result.Data["guildId"] != "761817" || result.Data["guildName"] != "Example Guild" {
		t.Fatalf("Missing guild origin: %#v", result.Data)
	}
	entry := result.Data["entries"].([]interface{})[0].(map[string]interface{})
	if entry["guildId"] != "761817" {
		t.Fatalf("Missing per-entry guild ID: %#v", entry)
	}
	unchanged, err := os.ReadFile(file)
	if err != nil || string(unchanged) != text {
		t.Fatal("Collection changed pending banking data")
	}
}

func TestRosterExportPreservesSnapshotAndEventGuildOrigin(t *testing.T) {
	file := filepath.Join(t.TempDir(), "GuildSyncRoster.lua")
	text := `GuildSyncRoster = { ["Default"] = { ["@Example"] = { ["$AccountWide"] = {
		["guildId"] = "761817", ["guildName"] = "Example Guild",
		["guildList"] = { ["guildId"] = "761817", ["guildName"] = "Example Guild", ["listTimestamp"] = 1780000000, ["guildListMembers"] = { ["@Example"] = { ["accountName"] = "@Example", ["rankName"] = "Soldier" } } },
		["rosterEvents"] = { ["event_123"] = { ["guildId"] = "761817", ["guildName"] = "Example Guild", ["eventId"] = 123, ["targetDisplayName"] = "@Example", ["eventType"] = "joined", ["timestampS"] = 1780000000 } }
	} } } }`
	if err := os.WriteFile(file, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	result := (&App{}).CollectGuildSyncRosterData(GuildSyncSavedVarsFileModifiedEvent{FileName: filepath.Base(file), FilePath: file})
	if !result.OK {
		t.Fatal(result.Message)
	}
	if result.Data["guildId"] != "761817" {
		t.Fatalf("Missing export guild ID: %#v", result.Data)
	}
	snapshot := result.Data["guildList"].(map[string]interface{})
	event := result.Data["rosterEvents"].(map[string]interface{})["event_123"].(map[string]interface{})
	if snapshot["guildId"] != "761817" || event["guildId"] != "761817" {
		t.Fatal("Snapshot/event lost guild origin")
	}
	unchanged, err := os.ReadFile(file)
	if err != nil || string(unchanged) != text {
		t.Fatal("Collection changed pending roster data")
	}
}

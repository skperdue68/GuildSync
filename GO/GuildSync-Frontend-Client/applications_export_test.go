package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestApplicationsCleanupPreservesChangedSnapshot(t *testing.T) {
	file := filepath.Join(t.TempDir(), "GuildSyncApplications.lua")
	text := `GuildSyncApplications = { ["Default"] = { ["@Officer"] = { ["$AccountWide"] = { ["records"] = { ["@Alice"] = { ["applicantAccount"] = "@Alice", ["capturedAt"] = 1000, ["applicationText"] = "First join" }, ["@Alice_2000"] = { ["applicantAccount"] = "@Alice", ["capturedAt"] = 2000, ["applicationText"] = "Second join" } } } } } }`
	if err := os.WriteFile(file, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
	app := &App{}
	result := app.CollectGuildSyncApplicationsData(GuildSyncSavedVarsFileModifiedEvent{FilePath: file})
	if !result.OK {
		t.Fatal(result.Message)
	}
	if result.Data["records_count"] != 2 {
		t.Fatal("same-account entries were lost")
	}
	// ESO writes new pending data while the exported batch is awaiting its ACK.
	changed := strings.Replace(text, `["records"] = {`, `["records"] = { ["@Alice_3000"] = { ["applicantAccount"] = "@Alice", ["capturedAt"] = 3000, ["applicationText"] = "Third join" },`, 1)
	if err := os.WriteFile(file, []byte(changed), 0600); err != nil {
		t.Fatal(err)
	}
	committed := app.CommitGuildSyncApplicationsData(file, "GuildSyncApplications.lua", result.Data["snapshot_hash"].(string))
	if committed.OK {
		t.Fatal("changed snapshot was cleared")
	}
	actual, err := os.ReadFile(file)
	if err != nil || string(actual) != changed {
		t.Fatal("newer pending data changed")
	}
	// A fresh collection can be acknowledged and cleared normally.
	result = app.CollectGuildSyncApplicationsData(GuildSyncSavedVarsFileModifiedEvent{FilePath: file})
	committed = app.CommitGuildSyncApplicationsData(file, "GuildSyncApplications.lua", result.Data["snapshot_hash"].(string))
	if !committed.OK {
		t.Fatal(committed.Message)
	}
	result = app.CollectGuildSyncApplicationsData(GuildSyncSavedVarsFileModifiedEvent{FilePath: file})
	if result.OK {
		t.Fatal("acknowledged records were not cleared")
	}
}

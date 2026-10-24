//go:build darwin && cgo

package main

/*
#cgo LDFLAGS: -framework ApplicationServices -framework Carbon
#include <ApplicationServices/ApplicationServices.h>
#include <Carbon/Carbon.h>

static int voice_mac_access(void) {
    if (__builtin_available(macOS 10.15, *)) {
        return CGPreflightListenEventAccess();
    }
    return 0;
}
static int voice_mac_request_access(void) {
    if (__builtin_available(macOS 10.15, *)) {
        return CGRequestListenEventAccess();
    }
    return 0;
}
static int voice_mac_down(unsigned short key) { return CGEventSourceKeyState(kCGEventSourceStateCombinedSessionState, key); }
static int voice_mac_character_key(int wanted) {
    TISInputSourceRef source = TISCopyCurrentKeyboardLayoutInputSource();
    if (!source) return -1;
    CFDataRef data = (CFDataRef)TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
    int result = -1;
    if (data) {
        const UCKeyboardLayout *layout = (const UCKeyboardLayout *)CFDataGetBytePtr(data);
        for (int key = 0; key < 128; key++) {
            UInt32 dead = 0; UniChar chars[4]; UniCharCount count = 0;
            OSStatus status = UCKeyTranslate(layout, key, kUCKeyActionDown, 0, LMGetKbdType(), kUCKeyTranslateNoDeadKeysBit, &dead, 4, &count, chars);
            if (status == noErr && count == 1 && chars[0] == wanted) { result = key; break; }
        }
    }
    CFRelease(source);
    return result;
}
*/
import "C"

import (
	"fmt"
	"sync"
	"time"
)

func voiceHotkeySupported() bool { return true }

func startVoiceKeyboard(v *voiceRuntime) (func(), error) {
	if C.voice_mac_access() == 0 && C.voice_mac_request_access() == 0 {
		return nil, fmt.Errorf("enable GuildSync in System Settings → Privacy & Security → Input Monitoring, then restart GuildSync")
	}
	shortcut, err := parseVoiceShortcut(v.settings.Shortcut)
	if err != nil {
		return nil, err
	}
	keys := make(map[int][]uint16)
	for _, key := range shortcut.keys {
		codes := voiceMacKeycodes(key)
		if (key >= 65 && key <= 90) || (key >= 48 && key <= 57) {
			character := key
			if key >= 65 {
				character += 32
			}
			if code := int(C.voice_mac_character_key(C.int(character))); code >= 0 {
				codes = []uint16{uint16(code)}
			}
		}
		if len(codes) == 0 {
			return nil, fmt.Errorf("shortcut key %d is unavailable on this Mac", key)
		}
		keys[key] = codes
	}
	generation := v.keyboardGeneration
	done := make(chan struct{})
	var once sync.Once
	go func() {
		ticker := time.NewTicker(25 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
			}
			if C.voice_mac_access() == 0 {
				v.keyboardError(generation, fmt.Errorf("GuildSync Input Monitoring permission was removed; re-enable it and restart GuildSync"))
				return
			}
			v.sampleKeyboard(generation, func(key int) bool {
				for _, code := range keys[key] {
					if C.voice_mac_down(C.ushort(code)) != 0 {
						return true
					}
				}
				return false
			})
		}
	}()
	return func() { once.Do(func() { close(done) }) }, nil
}

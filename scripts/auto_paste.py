import sys, time, ctypes

missing = []
try:    import pyautogui
except: missing.append('pyautogui')
try:    import pyperclip
except: missing.append('pyperclip')

if missing:
    print(f"MISSING_DEPS:{','.join(missing)}", flush=True)
    sys.exit(1)

CMD1 = "download_depot 252490 252494 5740964467494905272"
CMD2 = "download_depot 252490 252495 2089044749149059032"

pyautogui.FAILSAFE = False
pyautogui.PAUSE    = 0.05

user32 = ctypes.windll.user32

def log(msg): print(msg, flush=True)

def find_steam_window():
    found = []
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_size_t, ctypes.c_size_t)
    def cb(hwnd, _):
        if user32.IsWindowVisible(hwnd):
            buf = ctypes.create_unicode_buffer(512)
            user32.GetWindowTextW(hwnd, buf, 512)
            if 'Steam' in buf.value:
                found.append(hwnd)
        return True
    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return found[0] if found else None

def main():
    log("STATUS:Waiting for Steam console...")
    hwnd = None
    for _ in range(200):   # up to 20s timeout
        hwnd = find_steam_window()
        if hwnd:
            break
        time.sleep(0.1)

    if not hwnd:
        log("ERROR:Steam console not found. Open it manually and retry.")
        sys.exit(1)

    # Bring Steam window to foreground, then wait briefly for it to settle
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.3)

    log("STATUS:Sending command 1 of 2...")
    pyperclip.copy(CMD1)
    pyautogui.hotkey("ctrl", "v", interval=0.12)
    time.sleep(0.1)
    pyautogui.press("enter")
    time.sleep(0.5)

    log("STATUS:Sending command 2 of 2...")
    pyperclip.copy(CMD2)
    pyautogui.hotkey("ctrl", "v", interval=0.12)
    time.sleep(0.1)
    pyautogui.press("enter")

    log("STATUS:Both commands sent!")
    log("DONE")

if __name__ == "__main__":
    main()

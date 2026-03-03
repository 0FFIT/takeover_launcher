# auto_paste.ps1
# Uses SendInput (same API as Python pyautogui) to work with Steam's CEF console

$CMD1 = "download_depot 252490 252494 5740964467494905272"
$CMD2 = "download_depot 252490 252495 2089044749149059032"

function Write-Status($msg) { Write-Output "STATUS:$msg" }
function Write-Err($msg)    { Write-Output "ERROR:$msg" }

Add-Type -AssemblyName System.Windows.Forms

# Build C# type as concatenated strings - no here-string, no unicode
$cs  = "using System;"
$cs += "using System.Text;"
$cs += "using System.Runtime.InteropServices;"
$cs += "[StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {"
$cs += "  public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr extra;"
$cs += "}"
$cs += "[StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {"
$cs += "  public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra;"
$cs += "}"
$cs += "[StructLayout(LayoutKind.Explicit, Size=28)] public struct INPUT {"
$cs += "  [FieldOffset(0)] public uint type;"
$cs += "  [FieldOffset(4)] public MOUSEINPUT mi;"
$cs += "  [FieldOffset(4)] public KEYBDINPUT ki;"
$cs += "}"
$cs += "public class WinAPI {"
$cs += "  [DllImport(`"user32.dll`")] public static extern uint SendInput(uint n, INPUT[] inp, int sz);"
$cs += "  [DllImport(`"user32.dll`")] public static extern bool SetForegroundWindow(IntPtr h);"
$cs += "  [DllImport(`"user32.dll`")] public static extern bool ShowWindow(IntPtr h, int n);"
$cs += "  [DllImport(`"user32.dll`")] public static extern bool IsWindowVisible(IntPtr h);"
$cs += "  [DllImport(`"user32.dll`")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);"
$cs += "  [DllImport(`"user32.dll`")] public static extern bool GetWindowRect(IntPtr h, ref RECT r);"
$cs += "  [DllImport(`"user32.dll`")] public static extern bool EnumWindows(EnumCb f, IntPtr l);"
$cs += "  [DllImport(`"user32.dll`")] public static extern bool SetCursorPos(int x, int y);"
$cs += "  [DllImport(`"user32.dll`")] public static extern int GetSystemMetrics(int n);"
$cs += "  public delegate bool EnumCb(IntPtr h, IntPtr l);"
$cs += "}"
$cs += "[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }"

Add-Type -TypeDefinition $cs

# VK codes
$VK_CONTROL = 0x11
$VK_V       = 0x56
$VK_A       = 0x41
$VK_RETURN  = 0x0D
$KEYDOWN    = 0u
$KEYUP      = 2u
$MOUSE_MOVE = 0x0001u
$MOUSE_ABS  = 0x8000u
$MOUSE_DOWN = 0x0002u
$MOUSE_UP   = 0x0004u
$INPUT_MOUSE    = 0u
$INPUT_KEYBOARD = 1u

function Send-Key($vk, $flags) {
    $inp = New-Object INPUT
    $inp.type = $INPUT_KEYBOARD
    $inp.ki.wVk = [ushort]$vk
    $inp.ki.dwFlags = $flags
    [WinAPI]::SendInput(1, @($inp), [Runtime.InteropServices.Marshal]::SizeOf($inp)) | Out-Null
}

function Send-MouseClick($x, $y) {
    # Normalize coords to 0-65535 range for MOUSEEVENTF_ABSOLUTE (same as pyautogui)
    $sw = [WinAPI]::GetSystemMetrics(0)  # screen width
    $sh = [WinAPI]::GetSystemMetrics(1)  # screen height
    $nx = [int](($x * 65535) / $sw)
    $ny = [int](($y * 65535) / $sh)

    $move = New-Object INPUT
    $move.type = $INPUT_MOUSE
    $move.mi.dx = $nx
    $move.mi.dy = $ny
    $move.mi.dwFlags = $MOUSE_MOVE -bor $MOUSE_ABS

    $down = New-Object INPUT
    $down.type = $INPUT_MOUSE
    $down.mi.dx = $nx
    $down.mi.dy = $ny
    $down.mi.dwFlags = $MOUSE_DOWN -bor $MOUSE_ABS

    $up = New-Object INPUT
    $up.type = $INPUT_MOUSE
    $up.mi.dx = $nx
    $up.mi.dy = $ny
    $up.mi.dwFlags = $MOUSE_UP -bor $MOUSE_ABS

    [WinAPI]::SendInput(3, @($move, $down, $up), [Runtime.InteropServices.Marshal]::SizeOf($move)) | Out-Null
}

function Send-Paste {
    # Ctrl down, V down, V up, Ctrl up  (same sequence as pyautogui.hotkey)
    Send-Key $VK_CONTROL $KEYDOWN
    Start-Sleep -Milliseconds 30
    Send-Key $VK_V $KEYDOWN
    Start-Sleep -Milliseconds 30
    Send-Key $VK_V $KEYUP
    Start-Sleep -Milliseconds 30
    Send-Key $VK_CONTROL $KEYUP
}

function Send-SelectAll {
    Send-Key $VK_CONTROL $KEYDOWN
    Start-Sleep -Milliseconds 30
    Send-Key $VK_A $KEYDOWN
    Start-Sleep -Milliseconds 30
    Send-Key $VK_A $KEYUP
    Start-Sleep -Milliseconds 30
    Send-Key $VK_CONTROL $KEYUP
}

function Send-Enter {
    Send-Key $VK_RETURN $KEYDOWN
    Start-Sleep -Milliseconds 30
    Send-Key $VK_RETURN $KEYUP
}

Write-Status "Waiting for Steam console to open..."
Start-Sleep -Seconds 4

# Find Steam window
$script:hwnd = [IntPtr]::Zero
$cb = [WinAPI+EnumCb]{
    param([IntPtr]$h, [IntPtr]$l)
    if (-not [WinAPI]::IsWindowVisible($h)) { return $true }
    $sb = New-Object System.Text.StringBuilder 256
    [WinAPI]::GetWindowText($h, $sb, 256) | Out-Null
    $t = $sb.ToString()
    if ($t -match "Steam" -and $t.Trim() -ne "") {
        $script:hwnd = $h
        return $false
    }
    return $true
}
[WinAPI]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null

if ($script:hwnd -eq [IntPtr]::Zero) {
    Write-Err "Steam window not found. Make sure Steam is running."
    exit 1
}

$sb2 = New-Object System.Text.StringBuilder 256
[WinAPI]::GetWindowText($script:hwnd, $sb2, 256) | Out-Null
Write-Status "Found: $($sb2.ToString())"

function Click-SteamInput {
    [WinAPI]::ShowWindow($script:hwnd, 9) | Out-Null
    [WinAPI]::SetForegroundWindow($script:hwnd) | Out-Null
    Start-Sleep -Milliseconds 600

    $rect = New-Object RECT
    [WinAPI]::GetWindowRect($script:hwnd, [ref]$rect) | Out-Null

    $cx = [int](($rect.L + $rect.R) / 2)
    $cy = $rect.B - 18

    Send-MouseClick $cx $cy
    Start-Sleep -Milliseconds 300
}

function Paste-Command($cmd) {
    Click-SteamInput
    [System.Windows.Forms.Clipboard]::SetText($cmd)
    Start-Sleep -Milliseconds 150
    Send-SelectAll
    Start-Sleep -Milliseconds 100
    Send-Paste
    Start-Sleep -Milliseconds 150
    Send-Enter
}

Write-Status "Sending command 1 of 2..."
Paste-Command $CMD1
Start-Sleep -Seconds 2

Write-Status "Sending command 2 of 2..."
Paste-Command $CMD2

Write-Status "Both commands sent!"
Write-Output "DONE"

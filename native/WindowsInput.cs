// Build with the .NET Framework C# compiler and /reference:System.Web.Extensions.dll.
// stdin: one JSON object per line with allowedProcesses, key, and modifiers.
// stdout: one {status:"sent"} or {status:"error",code:"..."} per request.
// EOF stops the helper. No input is retried. Protocol errors never inject keys.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

internal static class WindowsInput
{
    private const int MaxLine = 4096;
    private const uint KeyUp = 2;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer
    {
        MaxJsonLength = MaxLine,
        RecursionLimit = 8
    };
    private static bool disabled;

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT { public uint type; public INPUTUNION data; }
    // MOUSEINPUT establishes the correct INPUT union size on both x86 and x64.
    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION
    {
        [FieldOffset(0)] public KEYBDINPUT keyboard;
        [FieldOffset(0)] public MOUSEINPUT mouse;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort key, scan;
        public uint flags, time;
        public UIntPtr extra;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int x, y;
        public uint mouseData, flags, time;
        public UIntPtr extra;
    }

    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint process);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);

    private static void Main()
    {
        if (Environment.OSVersion.Platform != PlatformID.Win32NT) return;
        Console.InputEncoding = new UTF8Encoding(false, true);
        Console.OutputEncoding = new UTF8Encoding(false);
        while (true)
        {
            string line;
            try { line = ReadLine(); }
            catch { Reply("invalid_request"); return; }
            if (line == null) return;
            try
            {
                if (disabled) { Reply("input_disabled"); continue; }
                string result = Handle(line);
                if (result == null) Console.WriteLine("{\"status\":\"sent\"}");
                else Reply(result);
            }
            catch { Reply("invalid_request"); }
        }
    }

    // Bound memory even when a client never supplies a newline.
    private static string ReadLine()
    {
        StringBuilder line = new StringBuilder();
        int value;
        while ((value = Console.In.Read()) != -1)
        {
            if (value == '\n') return line.ToString();
            if (line.Length >= MaxLine) throw new InvalidDataException();
            line.Append((char)value);
        }
        if (line.Length != 0) throw new InvalidDataException();
        return null;
    }

    private static string Handle(string line)
    {
        var request = Json.DeserializeObject(line) as Dictionary<string, object>;
        if (request == null || request.Count != 3 ||
            !request.ContainsKey("allowedProcesses") || !request.ContainsKey("key") ||
            !request.ContainsKey("modifiers")) return "invalid_request";
        var processes = request["allowedProcesses"] as object[];
        var modifiers = request["modifiers"] as object[];
        var key = request["key"] as string;
        if (processes == null || processes.Length == 0 || processes.Length > 16 ||
            modifiers == null || modifiers.Length > 3 || key == null) return "invalid_request";
        var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (object item in processes)
        {
            string name = item as string;
            if (name == null || name.Length > 128 ||
                !Regex.IsMatch(name, @"\A[A-Za-z0-9][A-Za-z0-9._-]*\.exe\z") ||
                !allowed.Add(name)) return "invalid_request";
        }
        ushort virtualKey;
        if (key == "Space") virtualKey = 0x20;
        else if (key == "Tab") virtualKey = 0x09;
        else if (key.Length == 1 && ((key[0] >= 'A' && key[0] <= 'Z') ||
            (key[0] >= '0' && key[0] <= '9'))) virtualKey = key[0];
        else
        {
            int number;
            if (!Regex.IsMatch(key, @"\AF([1-9]|1[0-2])\z") ||
                !int.TryParse(key.Substring(1), out number)) return "invalid_request";
            virtualKey = (ushort)(0x70 + number - 1);
        }
        var selected = new HashSet<string>();
        foreach (object item in modifiers)
        {
            string modifier = item as string;
            if ((modifier != "Ctrl" && modifier != "Alt" && modifier != "Shift") ||
                !selected.Add(modifier)) return "invalid_request";
        }
        var keys = new List<ushort>();
        if ((key == "Tab" || key == "F4") && selected.Contains("Alt")) return "invalid_request";
        if (selected.Contains("Ctrl")) keys.Add(0x11);
        if (selected.Contains("Alt")) keys.Add(0x12);
        if (selected.Contains("Shift")) keys.Add(0x10);
        keys.Add(virtualKey);
        var events = new List<INPUT>();
        foreach (ushort value in keys) events.Add(Event(value, false));
        for (int i = keys.Count - 1; i >= 0; i--) events.Add(Event(keys[i], true));

        // Check immediately before injection; foreground changes cannot be made atomic.
        foreach (int value in new int[] { 0x10, 0x11, 0x12, 0x5B, 0x5C })
            if ((GetAsyncKeyState(value) & 0x8000) != 0) return "modifier_held";
        if ((GetAsyncKeyState(virtualKey) & 0x8000) != 0) return "key_held";
        IntPtr window = GetForegroundWindow();
        if (window == IntPtr.Zero) return "foreground_unavailable";
        uint pid;
        if (GetWindowThreadProcessId(window, out pid) == 0 || pid == 0) return "foreground_unavailable";
        IntPtr process = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (process == IntPtr.Zero) return "foreground_unavailable";
        try
        {
            uint size = 32768;
            var path = new StringBuilder((int)size);
            if (!QueryFullProcessImageName(process, 0, path, ref size)) return "foreground_unavailable";
            if (!allowed.Contains(Path.GetFileName(path.ToString()))) return "foreground_mismatch";
        }
        finally { CloseHandle(process); }
        if (GetForegroundWindow() != window) return "foreground_changed";
        uint inserted = SendInput((uint)events.Count, events.ToArray(), Marshal.SizeOf(typeof(INPUT)));
        if (inserted != events.Count)
        {
            disabled = true;
            // Release only keys whose down events were accepted in this operation.
            var releases = new List<INPUT>();
            int pressed = Math.Min((int)inserted, keys.Count);
            for (int i = pressed - 1; i >= 0; i--) releases.Add(Event(keys[i], true));
            if (releases.Count > 0)
                SendInput((uint)releases.Count, releases.ToArray(), Marshal.SizeOf(typeof(INPUT)));
            return "injection_failed";
        }
        return null;
    }

    private static INPUT Event(ushort key, bool up)
    {
        return new INPUT { type = 1, data = new INPUTUNION {
            keyboard = new KEYBDINPUT { key = key, flags = up ? KeyUp : 0 }
        } };
    }

    private static void Reply(string code)
    {
        Console.WriteLine("{\"status\":\"error\",\"code\":\"" + code + "\"}");
    }
}

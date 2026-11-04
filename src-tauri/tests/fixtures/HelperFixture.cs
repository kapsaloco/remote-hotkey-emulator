// Test process only. No user32 references and no keyboard injection code.
using System;
using System.IO;
using System.Threading;
internal static class HelperFixture {
    private static void Main(string[] args) {
        string mode = args[0];
        string line;
        int count = 0;
        while ((line = Console.ReadLine()) != null) {
            if (args.Length > 1) File.AppendAllText(args[1], line + "\n");
            if (count++ == 0) {
                if (mode == "bad-start") { Console.WriteLine("not-json"); continue; }
                Console.WriteLine("{\"status\":\"error\",\"code\":\"invalid_request\"}");
                if (mode == "unsolicited") { Thread.Sleep(100); Console.WriteLine("{\"status\":\"sent\"}"); }
                continue;
            }
            if (mode == "exit") return;
            if (mode == "hang") { Thread.Sleep(10000); continue; }
            if (mode == "malformed") { Console.WriteLine("not-json"); continue; }
            if (mode == "oversized") { Console.Write(new string('x', 10000)); Console.Out.Flush(); continue; }
            if (mode == "extra") { Console.WriteLine("{\"status\":\"sent\",\"extra\":true}"); continue; }
            if (mode == "injection_failed") { Console.WriteLine("{\"status\":\"error\",\"code\":\"injection_failed\"}"); continue; }
            if (mode == "reject") { Console.WriteLine("{\"status\":\"error\",\"code\":\"foreground_mismatch\"}"); continue; }
            Console.WriteLine("{\"status\":\"sent\"}");
        }
    }
}

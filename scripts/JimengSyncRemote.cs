using System;
using System.Diagnostics;
using System.IO;

class JimengSyncRemote {
  static int Main() {
    string root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, ".."));
    if (!File.Exists(Path.Combine(root, "server.js"))) {
      root = Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, @"..\.."));
    }
    if (!File.Exists(Path.Combine(root, "server.js"))) {
      root = Directory.GetCurrentDirectory();
    }
    string launch = Path.Combine(root, "scripts", "launch-remote.js");
    if (!File.Exists(launch)) {
      Console.WriteLine("找不到 scripts/launch-remote.js");
      return 1;
    }
    var psi = new ProcessStartInfo();
    psi.FileName = "node";
    psi.Arguments = "\"" + launch + "\"";
    psi.WorkingDirectory = root;
    psi.UseShellExecute = false;
    try {
      var p = Process.Start(psi);
      if (p == null) return 1;
      p.WaitForExit();
      return p.ExitCode;
    } catch (Exception ex) {
      Console.WriteLine("需要已安装 Node.js。");
      Console.WriteLine(ex.Message);
      return 1;
    }
  }
}

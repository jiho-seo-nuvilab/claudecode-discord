using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using System.Threading;
using System.Runtime.InteropServices;

class ClaudeBotTray : Form
{
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, string lParam);
    private const int EM_SETCUEBANNER = 0x1501;

    private NotifyIcon trayIcon;
    private System.Windows.Forms.Timer refreshTimer;
    private System.Windows.Forms.Timer updateCheckTimer;
    private string botDir;
    private string envPath;
    private string taskName = "ClaudeDiscordBot";
    private string currentVersion = "unknown";
    private bool updateAvailable = false;

    public ClaudeBotTray()
    {
        botDir = Path.GetDirectoryName(Path.GetDirectoryName(Application.ExecutablePath));
        envPath = Path.Combine(botDir, ".env");

        this.ShowInTaskbar = false;
        this.WindowState = FormWindowState.Minimized;
        this.FormBorderStyle = FormBorderStyle.None;
        this.Opacity = 0;

        currentVersion = GetVersion();

        trayIcon = new NotifyIcon();
        trayIcon.Visible = true;
        // Left-click also shows menu
        trayIcon.MouseClick += (s, e) => {
            if (e.Button == MouseButtons.Left)
            {
                var mi = typeof(NotifyIcon).GetMethod("ShowContextMenu",
                    System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
                if (mi != null) mi.Invoke(trayIcon, null);
            }
        };
        UpdateStatus();
        BuildMenu();

        refreshTimer = new System.Windows.Forms.Timer();
        refreshTimer.Interval = 5000;
        refreshTimer.Tick += (s, e) => { UpdateStatus(); BuildMenu(); };
        refreshTimer.Start();

        // Check for updates every 5 minutes
        updateCheckTimer = new System.Windows.Forms.Timer();
        updateCheckTimer.Interval = 300000;
        updateCheckTimer.Tick += (s, e) => { CheckForUpdates(); BuildMenu(); };
        updateCheckTimer.Start();

        // Initial update check
        CheckForUpdates();

        if (!File.Exists(envPath))
        {
            // .env 없으면 설정 창 열기
            System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
            t.Interval = 500;
            t.Tick += (s, e) => { t.Stop(); OpenSettings(null, null); };
            t.Start();
        }
        else if (!IsRunning())
        {
            // .env 있고 봇이 안 돌고 있으면 자동 시작
            System.Windows.Forms.Timer t = new System.Windows.Forms.Timer();
            t.Interval = 1000;
            t.Tick += (s, e) => { t.Stop(); StartBot(null, null); };
            t.Start();
        }
    }

    private bool IsRunning()
    {
        return File.Exists(Path.Combine(botDir, ".bot.lock"));
    }

    private string GetVersion()
    {
        try
        {
            return RunCmdOutput("git", "-C \"" + botDir + "\" describe --tags --always").Trim();
        }
        catch { return "unknown"; }
    }

    private void CheckForUpdates()
    {
        try
        {
            RunCmdOutput("git", "-C \"" + botDir + "\" fetch origin main");
            string local = RunCmdOutput("git", "-C \"" + botDir + "\" rev-parse HEAD").Trim();
            string remote = RunCmdOutput("git", "-C \"" + botDir + "\" rev-parse origin/main").Trim();
            updateAvailable = !string.IsNullOrEmpty(local) && !string.IsNullOrEmpty(remote) && local != remote;
        }
        catch { updateAvailable = false; }
    }

    private void PerformUpdate(object sender, EventArgs e)
    {
        var result = MessageBox.Show(
            "Do you want to update to the latest version? The bot will restart after updating.",
            "Update Available",
            MessageBoxButtons.YesNo,
            MessageBoxIcon.Question);

        if (result != DialogResult.Yes) return;

        bool wasRunning = IsRunning();
        if (wasRunning)
        {
            RunCmd("\"" + Path.Combine(botDir, "win-start.bat") + "\" --stop", true);
            Thread.Sleep(2000);
        }

        RunCmdOutput("git", "-C \"" + botDir + "\" pull origin main");
        RunCmd("cd /d \"" + botDir + "\" && npm install --production && npm run build", true);

        currentVersion = GetVersion();
        updateAvailable = false;

        if (wasRunning)
        {
            RunCmd("\"" + Path.Combine(botDir, "win-start.bat") + "\"", false);
            Thread.Sleep(2000);
        }

        MessageBox.Show("Updated to version: " + currentVersion, "Update Complete", MessageBoxButtons.OK, MessageBoxIcon.Information);
        UpdateStatus();
        BuildMenu();
    }

    private string RunCmdOutput(string fileName, string arguments)
    {
        try
        {
            var proc = new Process();
            proc.StartInfo.FileName = fileName;
            proc.StartInfo.Arguments = arguments;
            proc.StartInfo.UseShellExecute = false;
            proc.StartInfo.RedirectStandardOutput = true;
            proc.StartInfo.CreateNoWindow = true;
            proc.StartInfo.WorkingDirectory = botDir;
            proc.Start();
            string output = proc.StandardOutput.ReadToEnd();
            proc.WaitForExit();
            return output;
        }
        catch { return ""; }
    }

    private Bitmap CreateIcon(Color color)
    {
        var bmp = new Bitmap(16, 16);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            g.FillEllipse(new SolidBrush(color), 1, 1, 14, 14);
        }
        return bmp;
    }

    private void UpdateStatus()
    {
        bool running = IsRunning();
        bool hasEnv = File.Exists(envPath);

        if (!hasEnv)
        {
            trayIcon.Icon = Icon.FromHandle(CreateIcon(Color.Orange).GetHicon());
            trayIcon.Text = "Claude Bot: Setup Required";
        }
        else if (running)
        {
            trayIcon.Icon = Icon.FromHandle(CreateIcon(Color.LimeGreen).GetHicon());
            trayIcon.Text = "Claude Bot: Running";
        }
        else
        {
            trayIcon.Icon = Icon.FromHandle(CreateIcon(Color.Red).GetHicon());
            trayIcon.Text = "Claude Bot: Stopped";
        }
    }

    private void BuildMenu()
    {
        bool running = IsRunning();
        bool hasEnv = File.Exists(envPath);

        var menu = new ContextMenuStrip();

        if (!hasEnv)
        {
            var noEnv = new ToolStripMenuItem("Setup Required") { Enabled = false };
            menu.Items.Add(noEnv);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Setup...", null, OpenSettings);
        }
        else
        {
            var status = new ToolStripMenuItem(running ? "Running" : "Stopped") { Enabled = false };
            menu.Items.Add(status);
            menu.Items.Add(new ToolStripSeparator());

            if (running)
            {
                menu.Items.Add("Stop Bot", null, StopBot);
                menu.Items.Add("Restart Bot", null, RestartBot);
            }
            else
            {
                menu.Items.Add("Start Bot", null, StartBot);
            }

            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Settings...", null, OpenSettings);
            menu.Items.Add("View Log", null, OpenLog);
            menu.Items.Add("Open Folder", null, OpenFolder);
        }

        menu.Items.Add(new ToolStripSeparator());

        // Auto-start toggle
        var autoStartItem = new ToolStripMenuItem("Auto Run on Startup");
        autoStartItem.Checked = IsAutoStartEnabled();
        autoStartItem.Click += ToggleAutoStart;
        menu.Items.Add(autoStartItem);

        var versionItem = new ToolStripMenuItem("Version: " + currentVersion) { Enabled = false };
        menu.Items.Add(versionItem);

        if (updateAvailable)
        {
            menu.Items.Add("Update Available", null, PerformUpdate);
        }

        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit", null, QuitAll);

        trayIcon.ContextMenuStrip = menu;
    }

    private void StartBot(object sender, EventArgs e)
    {
        KillBot();
        // Run bot hidden via vbs
        string vbs = Path.Combine(botDir, ".bot-start.vbs");
        string cmd = "cmd /c cd /d " + botDir + " & echo running> .bot.lock & node dist/index.js & del .bot.lock";
        File.WriteAllText(vbs, "Set ws = CreateObject(\"WScript.Shell\")\nws.Run \"" + cmd.Replace("\"", "\"\"") + "\", 0, False\n");
        Process.Start("wscript", "\"" + vbs + "\"");
        // Wait for bot to start, then show notification
        System.Windows.Forms.Timer waitTimer = new System.Windows.Forms.Timer();
        waitTimer.Interval = 1000;
        int waitCount = 0;
        waitTimer.Tick += (s2, e2) => {
            waitCount++;
            if (IsRunning())
            {
                waitTimer.Stop();
                try { File.Delete(vbs); } catch { }
                UpdateStatus();
                BuildMenu();
                trayIcon.BalloonTipTitle = "Claude Bot Started";
                trayIcon.BalloonTipText = "Bot is running. Right-click tray icon to manage.";
                trayIcon.BalloonTipIcon = ToolTipIcon.Info;
                trayIcon.ShowBalloonTip(3000);
            }
            else if (waitCount > 10)
            {
                waitTimer.Stop();
                try { File.Delete(vbs); } catch { }
                UpdateStatus();
                BuildMenu();
            }
        };
        waitTimer.Start();
    }

    private void KillBot()
    {
        // Kill node processes running dist/index.js
        try
        {
            var proc = new Process();
            proc.StartInfo.FileName = "wmic";
            proc.StartInfo.Arguments = "process where \"commandline like '%dist/index.js%' and name='node.exe'\" call terminate";
            proc.StartInfo.UseShellExecute = false;
            proc.StartInfo.CreateNoWindow = true;
            proc.Start();
            proc.WaitForExit();
        }
        catch { }
        // Also try taskkill for cmd windows
        try
        {
            var proc = new Process();
            proc.StartInfo.FileName = "cmd.exe";
            proc.StartInfo.Arguments = "/c for /f \"tokens=2\" %a in ('tasklist /fi \"windowtitle eq ClaudeDiscordBot\" /fo list 2^>nul ^| findstr \"PID\"') do taskkill /pid %a /f >nul 2>&1";
            proc.StartInfo.UseShellExecute = false;
            proc.StartInfo.CreateNoWindow = true;
            proc.Start();
            proc.WaitForExit();
        }
        catch { }
        string lockFile = Path.Combine(botDir, ".bot.lock");
        try { File.Delete(lockFile); } catch { }
    }

    private bool IsAutoStartEnabled()
    {
        try
        {
            var proc = new Process();
            proc.StartInfo.FileName = "schtasks";
            proc.StartInfo.Arguments = "/query /tn \"" + taskName + "\"";
            proc.StartInfo.UseShellExecute = false;
            proc.StartInfo.RedirectStandardOutput = true;
            proc.StartInfo.CreateNoWindow = true;
            proc.Start();
            proc.WaitForExit();
            return proc.ExitCode == 0;
        }
        catch { return false; }
    }

    private void ToggleAutoStart(object sender, EventArgs e)
    {
        if (IsAutoStartEnabled())
        {
            RunCmd("schtasks /delete /tn \"" + taskName + "\" /f", true);
        }
        else
        {
            string exePath = Application.ExecutablePath;
            RunCmd("schtasks /create /tn \"" + taskName + "\" /tr \"\\\"" + exePath + "\\\"\" /sc onlogon /rl highest /f", true);
        }
        BuildMenu();
    }

    private void StopBot(object sender, EventArgs e)
    {
        KillBot();
        Thread.Sleep(1000);
        UpdateStatus();
        BuildMenu();
    }

    private void RestartBot(object sender, EventArgs e)
    {
        KillBot();
        Thread.Sleep(2000);
        StartBot(null, null);
    }

    private void OpenLog(object sender, EventArgs e)
    {
        string logPath = Path.Combine(botDir, "bot.log");
        if (File.Exists(logPath))
            Process.Start("notepad.exe", logPath);
    }

    private void OpenFolder(object sender, EventArgs e)
    {
        Process.Start("explorer.exe", botDir);
    }

    private void OpenSettings(object sender, EventArgs e)
    {
        var env = LoadEnv();

        var form = new Form()
        {
            Text = "Claude Discord Bot Settings",
            Width = 500,
            Height = 430,
            StartPosition = FormStartPosition.CenterScreen,
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
        };

        // Setup guide link
        var linkLabel = new LinkLabel() { Text = "Open Setup Guide", Left = 15, Top = 10, Width = 450 };
        linkLabel.LinkClicked += (s, ev) => { Process.Start("https://github.com/chadingTV/claudecode-discord/blob/main/SETUP.md"); };
        form.Controls.Add(linkLabel);

        string[][] fields = new string[][] {
            new string[] { "DISCORD_BOT_TOKEN", "Discord Bot Token" },
            new string[] { "DISCORD_GUILD_ID", "Discord Guild ID" },
            new string[] { "ALLOWED_USER_IDS", "Allowed User IDs (comma-separated)" },
            new string[] { "BASE_PROJECT_DIR", "Base Project Directory" },
            new string[] { "RATE_LIMIT_PER_MINUTE", "Rate Limit Per Minute" },
            new string[] { "SHOW_COST", "Show Cost (true/false)" },
        };

        string[] defaults = new string[] { "", "", "", botDir, "10", "true" };

        var textBoxes = new TextBox[fields.Length];
        int y = 35;

        for (int i = 0; i < fields.Length; i++)
        {
            var label = new Label() { Text = fields[i][1], Left = 15, Top = y, Width = 450, Font = new Font(FontFamily.GenericSansSerif, 9, FontStyle.Bold) };
            form.Controls.Add(label);
            y += 20;

            if (fields[i][0] == "BASE_PROJECT_DIR")
            {
                var tb = new TextBox() { Left = 15, Top = y, Width = 360 };
                string val = "";
                env.TryGetValue(fields[i][0], out val);
                tb.Text = (val != null && val != "") ? val : defaults[i];
                form.Controls.Add(tb);
                textBoxes[i] = tb;

                var browseBtn = new Button() { Text = "Browse...", Left = 380, Top = y - 1, Width = 85 };
                int idx = i;
                browseBtn.Click += (s, ev) =>
                {
                    using (var fbd = new FolderBrowserDialog())
                    {
                        fbd.Description = "Select Base Project Directory";
                        if (textBoxes[idx].Text != "") fbd.SelectedPath = textBoxes[idx].Text;
                        if (fbd.ShowDialog() == DialogResult.OK)
                        {
                            textBoxes[idx].Text = fbd.SelectedPath;
                        }
                    }
                };
                form.Controls.Add(browseBtn);
            }
            else
            {
                var tb = new TextBox() { Left = 15, Top = y, Width = 450 };
                string val = "";
                env.TryGetValue(fields[i][0], out val);

                if (fields[i][0] == "DISCORD_BOT_TOKEN" && val != null && val.Length > 10)
                {
                    tb.HandleCreated += (s2, e2) => {
                        SendMessage(((TextBox)s2).Handle, EM_SETCUEBANNER, IntPtr.Zero,
                            "****" + val.Substring(val.Length - 6) + " (enter full token to change)");
                    };
                }
                else
                {
                    tb.Text = (val != null && val != "") ? val : defaults[i];
                }

                form.Controls.Add(tb);
                textBoxes[i] = tb;
            }
            y += 30;
        }

        var note = new Label() { Text = "* Max plan users should set Show Cost to false", Left = 15, Top = y, Width = 450, ForeColor = Color.Gray };
        form.Controls.Add(note);
        y += 25;

        var saveBtn = new Button() { Text = "Save", Left = 300, Top = y, Width = 80 };
        var cancelBtn = new Button() { Text = "Cancel", Left = 385, Top = y, Width = 80 };

        saveBtn.Click += (s, ev) =>
        {
            string[] values = new string[fields.Length];
            for (int i = 0; i < fields.Length; i++)
            {
                values[i] = textBoxes[i].Text.Trim();
                if (values[i] == "" && fields[i][0] == "DISCORD_BOT_TOKEN")
                {
                    string existing = "";
                    env.TryGetValue(fields[i][0], out existing);
                    values[i] = existing ?? "";
                }
                if (values[i] == "") values[i] = defaults[i];
            }

            if (values[0] == "" || values[1] == "" || values[2] == "")
            {
                MessageBox.Show("Bot Token, Guild ID, and User IDs are required.", "Required Fields Missing", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            using (var sw = new StreamWriter(envPath))
            {
                for (int i = 0; i < fields.Length; i++)
                {
                    if (fields[i][0] == "SHOW_COST")
                        sw.WriteLine("# Show estimated API cost in task results (set false for Max plan users)");
                    sw.WriteLine(fields[i][0] + "=" + values[i]);
                }
            }

            form.DialogResult = DialogResult.OK;
            form.Close();
        };

        cancelBtn.Click += (s, ev) => { form.Close(); };

        form.Controls.Add(saveBtn);
        form.Controls.Add(cancelBtn);
        form.AcceptButton = saveBtn;
        form.CancelButton = cancelBtn;
        form.ShowDialog();

        UpdateStatus();
        BuildMenu();
    }

    private System.Collections.Generic.Dictionary<string, string> LoadEnv()
    {
        var env = new System.Collections.Generic.Dictionary<string, string>();
        if (!File.Exists(envPath)) return env;

        foreach (var line in File.ReadAllLines(envPath))
        {
            string trimmed = line.Trim();
            if (trimmed.StartsWith("#") || !trimmed.Contains("=")) continue;
            int idx = trimmed.IndexOf('=');
            string key = trimmed.Substring(0, idx);
            string val = trimmed.Substring(idx + 1);
            env[key] = val;
        }
        return env;
    }

    private void QuitAll(object sender, EventArgs e)
    {
        KillBot();
        trayIcon.Visible = false;
        Application.Exit();
    }

    private void RunCmd(string command, bool wait)
    {
        var proc = new Process();
        proc.StartInfo.FileName = "cmd.exe";
        proc.StartInfo.Arguments = "/c " + command;
        proc.StartInfo.UseShellExecute = false;
        proc.StartInfo.CreateNoWindow = true;
        proc.Start();
        if (wait) proc.WaitForExit();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        trayIcon.Visible = false;
        base.OnFormClosing(e);
    }

    [STAThread]
    static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new ClaudeBotTray());
    }
}

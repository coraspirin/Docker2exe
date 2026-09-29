// docker2exe tek dosya (self-extracting) exe stub'ı.
//
// Dosya düzeni: [bu stub][zip payload][meta (UTF-8 key=value satırları)][int32 metaLen][int64 payloadLen]["D2ESFX01"]
// İlk çalıştırmada payload %LOCALAPPDATA%\<root>\<version> altına açılır (tamamlanınca işaret dosyası yazılır),
// sonraki çalıştırmalarda doğrudan meta'daki exe başlatılır. Aynı kökteki eski sürümler, kullanımda değilse silinir.
//
// src/packager/sfx.js tarafından .NET Framework csc.exe ile derlenir (C# 5): /define:GUI → konsolsuz,
// ilerleme penceresi olan uygulama stub'ı; tanımsız → konsol aracı stub'ı (docker2exe.exe).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
#if GUI
using System.Drawing;
using System.Windows.Forms;
#endif

static class Sfx
{
    const string Magic = "D2ESFX01";
    const string CompleteMarker = ".d2e-sfx-complete";
    const int TrailerSize = 4 + 8 + 8;

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint GetConsoleProcessList(uint[] processList, uint processCount);

    [DllImport("user32.dll")]
    static extern bool SetProcessDPIAware();

    [STAThread]
    static int Main()
    {
        // Uzun yol (>260) desteği: .NET 4.6.2+ switch'leri ilk IO çağrısından önce ayarlanmalı.
        AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
        AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
#if GUI
        try { SetProcessDPIAware(); } catch { } // yüksek DPI'da bulanık bitmap ölçekleme yerine net çizim
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
#else
        try { Console.OutputEncoding = Encoding.UTF8; } catch { }
#endif
        string title = "docker2exe";
        try
        {
            string self = Assembly.GetEntryAssembly().Location;
            long payloadOffset, payloadLength;
            Dictionary<string, string> meta = ReadMeta(self, out payloadOffset, out payloadLength);
            title = meta["name"];
            string target = Prepare(self, meta, payloadOffset, payloadLength);
            return Launch(target, meta);
        }
        catch (Exception e)
        {
            ShowError(title, e.Message);
            return 1;
        }
    }

    // ------------------------------------------------------------------ payload

    static Dictionary<string, string> ReadMeta(string self, out long payloadOffset, out long payloadLength)
    {
        using (var fs = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (fs.Length < TrailerSize) throw new Exception("Exe bozuk: payload bulunamadı.");
            var trailer = new byte[TrailerSize];
            fs.Seek(-TrailerSize, SeekOrigin.End);
            ReadFully(fs, trailer);
            if (Encoding.ASCII.GetString(trailer, 12, 8) != Magic) throw new Exception("Exe bozuk: payload imzası yok.");
            int metaLength = BitConverter.ToInt32(trailer, 0);
            payloadLength = BitConverter.ToInt64(trailer, 4);
            payloadOffset = fs.Length - TrailerSize - metaLength - payloadLength;
            if (metaLength <= 0 || payloadOffset < 0) throw new Exception("Exe bozuk: geçersiz payload boyutu.");

            var metaBytes = new byte[metaLength];
            fs.Seek(-TrailerSize - metaLength, SeekOrigin.End);
            ReadFully(fs, metaBytes);
            var meta = new Dictionary<string, string>();
            foreach (string line in Encoding.UTF8.GetString(metaBytes).Split('\n'))
            {
                int eq = line.IndexOf('=');
                if (eq > 0) meta[line.Substring(0, eq)] = line.Substring(eq + 1);
            }
            foreach (string key in new[] { "name", "id", "root", "version", "exe" })
            {
                if (!meta.ContainsKey(key)) throw new Exception("Exe bozuk: meta alanı eksik: " + key);
            }
            return meta;
        }
    }

    static void ReadFully(Stream s, byte[] buffer)
    {
        int read = 0;
        while (read < buffer.Length)
        {
            int n = s.Read(buffer, read, buffer.Length - read);
            if (n <= 0) throw new EndOfStreamException();
            read += n;
        }
    }

    /// <summary>Hedef klasör hazır değilse payload'ı açar; hedef klasör yolunu döner.</summary>
    static string Prepare(string self, Dictionary<string, string> meta, long payloadOffset, long payloadLength)
    {
        string baseDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), meta["root"]);
        string target = Path.Combine(baseDir, meta["version"]);

        bool owned;
        using (var mutex = new Mutex(false, "Local\\docker2exe-sfx-" + meta["id"], out owned))
        {
            try { mutex.WaitOne(); } catch (AbandonedMutexException) { }
            try
            {
                if (!File.Exists(Path.Combine(target, CompleteMarker)))
                {
                    string strip = meta.ContainsKey("strip") ? meta["strip"] : "";
                    Extract(self, payloadOffset, payloadLength, strip, target, meta["name"]);
                }
                // Her başlatmada: önceki sürüm o an çalıştığı için silinemediyse sonraki başlatmada silinir.
                RemoveOldVersions(baseDir, target);
            }
            finally
            {
                mutex.ReleaseMutex();
            }
        }
        return target;
    }

    static void Extract(string self, long offset, long length, string strip, string target, string name)
    {
        string partial = target + ".partial";
        if (Directory.Exists(partial)) Directory.Delete(partial, true);
        if (Directory.Exists(target)) Directory.Delete(target, true); // işaret dosyası olmayan yarım açılım
        Directory.CreateDirectory(partial);
        string root = Path.GetFullPath(partial) + Path.DirectorySeparatorChar;

        var progress = new Progress(name);
        Exception error = null;
        var worker = new Thread(() =>
        {
            try
            {
                using (var fs = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
                using (var zip = new ZipArchive(new SubStream(fs, offset, length), ZipArchiveMode.Read, false, Encoding.UTF8))
                {
                    long total = 0, done = 0;
                    foreach (var entry in zip.Entries) total += entry.Length;
                    var buffer = new byte[1 << 16];
                    foreach (var entry in zip.Entries)
                    {
                        string rel = entry.FullName.Replace('\\', '/');
                        if (strip.Length > 0)
                        {
                            if (!rel.StartsWith(strip, StringComparison.Ordinal)) continue;
                            rel = rel.Substring(strip.Length);
                        }
                        if (rel.Length == 0) continue;
                        string dest = Path.GetFullPath(Path.Combine(partial, rel.Replace('/', Path.DirectorySeparatorChar)));
                        if (!dest.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new Exception("Payload geçersiz yol içeriyor: " + entry.FullName);
                        if (rel.EndsWith("/"))
                        {
                            Directory.CreateDirectory(dest);
                            continue;
                        }
                        Directory.CreateDirectory(Path.GetDirectoryName(dest));
                        using (var input = entry.Open())
                        using (var output = new FileStream(dest, FileMode.Create, FileAccess.Write, FileShare.None))
                        {
                            int n;
                            while ((n = input.Read(buffer, 0, buffer.Length)) > 0)
                            {
                                output.Write(buffer, 0, n);
                                done += n;
                                progress.Report(done, total);
                            }
                        }
                        File.SetLastWriteTime(dest, entry.LastWriteTime.DateTime);
                    }
                    File.WriteAllText(Path.Combine(partial, CompleteMarker), DateTime.Now.ToString("o"));
                }
            }
            catch (Exception e)
            {
                error = e;
            }
            finally
            {
                progress.Done();
            }
        });
        worker.Start();
        progress.Run();
        worker.Join();
        if (error != null)
        {
            try { Directory.Delete(partial, true); } catch { }
            throw new Exception("Paket açılamadı (" + target + "):\n" + error.Message);
        }
        Directory.Move(partial, target);
    }

    /// <summary>
    /// Aynı kökteki eski sürüm klasörlerini siler. Önce yeniden adlandırılır: klasörde çalışan bir süreç
    /// (eski sürüm hâlâ açık) varsa Windows adlandırmayı reddeder ve klasöre dokunulmaz.
    /// </summary>
    static void RemoveOldVersions(string baseDir, string current)
    {
        foreach (string dir in Directory.GetDirectories(baseDir))
        {
            if (string.Equals(dir, current, StringComparison.OrdinalIgnoreCase)) continue;
            bool ours = File.Exists(Path.Combine(dir, CompleteMarker)) || dir.EndsWith(".partial") || dir.Contains(".old-");
            if (!ours) continue;
            try
            {
                string doomed = dir.Contains(".old-") ? dir : dir + ".old-" + Guid.NewGuid().ToString("N").Substring(0, 8);
                if (doomed != dir) Directory.Move(dir, doomed);
                Directory.Delete(doomed, true);
            }
            catch { }
        }
    }

    // ------------------------------------------------------------------ başlatma

    static int Launch(string target, Dictionary<string, string> meta)
    {
        string exe = Path.Combine(target, meta["exe"]);
        string prefix = meta.ContainsKey("args") ? meta["args"].Replace("{dir}", target) : "";
        string tail = CommandLineTail();
        var psi = new ProcessStartInfo(exe, (prefix + " " + tail).Trim());
        psi.UseShellExecute = false;
#if GUI
        psi.WorkingDirectory = target;
        if (tail.Length > 0)
        {
            // --stop gibi komutlar: pencere yok, sonucu bekle.
            using (var child = Process.Start(psi))
            {
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        // Normal başlatma: açık kalan durum penceresi; kapatılınca uygulama ve servisler durdurulur.
        return StatusWindow.Run(meta["name"], meta["id"], psi);
#else
        // Explorer'dan çift tık / sürükle-bırak: konsol sadece bu sürece ait → çıktı okunabilsin diye sonda beklenir,
        // çıktı klasörü exe'nin yanına düşsün diye çalışma klasörü exe klasörü yapılır.
        bool ownConsole = GetConsoleProcessList(new uint[4], 4) == 1;
        psi.WorkingDirectory = ownConsole ? Path.GetDirectoryName(Assembly.GetEntryAssembly().Location) : Environment.CurrentDirectory;
        if (ownConsole) psi.EnvironmentVariables["D2E_OWN_CONSOLE"] = "1";
        Console.CancelKeyPress += (s, e) => { e.Cancel = true; }; // Ctrl+C alt süreci durdurur, stub çıkış kodunu bekler
        int code;
        using (var child = Process.Start(psi))
        {
            child.WaitForExit();
            code = child.ExitCode;
        }
        if (ownConsole)
        {
            Console.WriteLine();
            Console.Write("Kapatmak için Enter'a basın...");
            Console.ReadLine();
        }
        return code;
#endif
    }

    /// <summary>Kendi komut satırından exe adını çıkarır; kalan kısım alıntılarıyla aynen alt sürece aktarılır.</summary>
    static string CommandLineTail()
    {
        string cl = Environment.CommandLine;
        int i = 0;
        if (cl.Length > 0 && cl[0] == '"')
        {
            int end = cl.IndexOf('"', 1);
            i = end < 0 ? cl.Length : end + 1;
        }
        else
        {
            while (i < cl.Length && cl[i] != ' ' && cl[i] != '\t') i++;
        }
        return cl.Substring(i).Trim();
    }

    static void ShowError(string title, string message)
    {
#if GUI
        MessageBox.Show(message, title, MessageBoxButtons.OK, MessageBoxIcon.Error);
#else
        Console.Error.WriteLine();
        Console.Error.WriteLine("✖ " + title + ": " + message);
        if (GetConsoleProcessList(new uint[4], 4) == 1)
        {
            Console.Error.Write("Kapatmak için Enter'a basın...");
            Console.ReadLine();
        }
#endif
    }

    // ------------------------------------------------------------------ ilerleme

#if GUI
    sealed class Progress
    {
        readonly Form form;
        readonly ProgressBar bar;
        int last = -1;

        public Progress(string name)
        {
            form = new Form();
            form.Text = name;
            form.FormBorderStyle = FormBorderStyle.FixedDialog;
            form.MaximizeBox = false;
            form.MinimizeBox = false;
            form.StartPosition = FormStartPosition.CenterScreen;
            form.ClientSize = new Size(380, 90);
            try { form.Icon = Icon.ExtractAssociatedIcon(Assembly.GetEntryAssembly().Location); } catch { }
            var label = new Label();
            label.Text = name + " ilk çalıştırma için hazırlanıyor...";
            label.AutoSize = false;
            label.SetBounds(16, 16, 348, 22);
            bar = new ProgressBar();
            bar.SetBounds(16, 46, 348, 22);
            bar.Maximum = 100;
            form.Controls.Add(label);
            form.Controls.Add(bar);
            ScaleForDpi(form);
            form.FormClosing += (s, e) => { if (e.CloseReason == CloseReason.UserClosing) e.Cancel = true; };
        }

        public void Report(long done, long total)
        {
            int pct = total > 0 ? (int)(done * 100 / total) : 0;
            if (pct == last) return;
            last = pct;
            if (form.IsHandleCreated) form.BeginInvoke(new Action(() => bar.Value = Math.Min(pct, 100)));
        }

        public void Done()
        {
            // Pencere henüz oluşmadıysa Run() Shown olayında kapanır.
            done = true;
            if (form.IsHandleCreated) form.BeginInvoke(new Action(() => form.Hide()));
        }

        volatile bool done;

        public void Run()
        {
            form.Shown += (s, e) => { if (done) form.Hide(); };
            form.VisibleChanged += (s, e) => { if (!form.Visible) Application.ExitThread(); };
            Application.Run(form);
            form.Dispose();
        }
    }

    /// <summary>
    /// Uygulama çalıştığı sürece açık kalan pencere. Durum launcher'ın kontrol kanalından (named pipe "status")
    /// okunur; pencere kapatılınca "stop" gönderilir ve launcher'ın servisleri düzgün kapatması beklenir.
    /// Uygulama zaten çalışıyorsa (Başlat.bat veya önceki açılış) yeni launcher başlatılmaz, pencere ona bağlanır;
    /// açık bir pencere varsa yenisi açılmaz, mevcut pencere öne getirilir.
    /// </summary>
    sealed class StatusWindow : Form
    {
        const int StopTimeoutMs = 120000;

        readonly string appName;
        readonly string pipeName;
        readonly ProcessStartInfo psi;
        readonly Label status;
        readonly LinkLabel link;
        readonly Button openButton;
        readonly Button stopButton;
        Process launcher;
        string url;
        bool stopping;
        bool allowClose;
        volatile bool closed;

        public static int Run(string appName, string id, ProcessStartInfo psi)
        {
            bool created;
            using (var single = new Mutex(true, "Local\\docker2exe-window-" + id, out created))
            using (var show = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\docker2exe-show-" + id))
            {
                if (!created)
                {
                    show.Set();
                    return 0;
                }
                try
                {
                    var window = new StatusWindow(appName, id, psi);
                    var listener = new Thread(() =>
                    {
                        try
                        {
                            while (show.WaitOne() && !window.closed)
                            {
                                window.BeginInvoke(new Action(window.ShowFromOtherInstance));
                            }
                        }
                        catch { } // pencere/olay kapanırken
                    });
                    listener.IsBackground = true;
                    listener.Start();
                    Application.Run(window);
                    return 0;
                }
                finally
                {
                    single.ReleaseMutex();
                }
            }
        }

        StatusWindow(string appName, string id, ProcessStartInfo psi)
        {
            this.appName = appName;
            this.pipeName = "docker2exe-" + id;
            this.psi = psi;

            Text = appName;
            FormBorderStyle = FormBorderStyle.FixedSingle;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(440, 176);
            Font = new Font("Segoe UI", 9f);
            try { Icon = Icon.ExtractAssociatedIcon(Assembly.GetEntryAssembly().Location); } catch { }

            var title = new Label();
            title.Text = appName;
            title.Font = new Font("Segoe UI", 13f, FontStyle.Bold);
            title.AutoEllipsis = true;
            title.SetBounds(16, 12, 408, 28);

            status = new Label();
            status.Text = "Başlatılıyor...";
            status.SetBounds(16, 44, 408, 20);

            link = new LinkLabel();
            link.SetBounds(16, 66, 408, 20);
            link.Visible = false;
            link.LinkClicked += (s, e) => OpenBrowser();

            var hint = new Label();
            hint.Text = "Bu pencereyi kapattığınızda uygulama ve veritabanları durdurulur.";
            hint.ForeColor = SystemColors.GrayText;
            hint.SetBounds(16, 96, 408, 20);

            openButton = new Button();
            openButton.Text = "Tarayıcıda aç";
            openButton.Enabled = false;
            openButton.SetBounds(186, 130, 116, 30);
            openButton.Click += (s, e) => OpenBrowser();

            stopButton = new Button();
            stopButton.Text = "Durdur ve kapat";
            stopButton.SetBounds(308, 130, 116, 30);
            stopButton.Click += (s, e) => Close();

            Controls.AddRange(new Control[] { title, status, link, hint, openButton, stopButton });
            ScaleForDpi(this);
        }

        protected override void OnShown(EventArgs e)
        {
            base.OnShown(e);
            // Zaten çalışan bir örnek varsa ona bağlan (ikinci launcher başlatma).
            if (Query("status", 300) == null)
            {
                try
                {
                    launcher = Process.Start(psi);
                }
                catch (Exception ex)
                {
                    allowClose = true;
                    MessageBox.Show("Başlatılamadı: " + ex.Message, appName, MessageBoxButtons.OK, MessageBoxIcon.Error);
                    Close();
                    return;
                }
            }
            var poller = new Thread(() =>
            {
                while (!closed)
                {
                    string reply = Query("status", 500);
                    try { BeginInvoke(new Action(() => OnStatus(reply))); } catch { return; }
                    Thread.Sleep(1000);
                }
            });
            poller.IsBackground = true;
            poller.Start();
        }

        void OnStatus(string reply)
        {
            if (stopping || closed) return;
            if (reply == null)
            {
                bool launcherAlive = launcher != null && !launcher.HasExited;
                if (launcherAlive) return; // kontrol kanalı henüz açılmadı
                // Launcher kapandı: hata (launcher kendi mesajını gösterir) veya dışarıdan durduruldu (Durdur.bat, --stop).
                allowClose = true;
                Close();
                return;
            }
            string[] parts = reply.Split('\t');
            string state = parts[0];
            string newUrl = parts.Length > 1 && parts[1].Length > 0 ? parts[1] : null;
            status.Text = Describe(state);
            status.ForeColor = state == "RUNNING" || state == "OPEN_BROWSER" ? Color.ForestGreen : SystemColors.ControlText;
            if (newUrl != null && newUrl != url)
            {
                url = newUrl;
                link.Text = url;
                link.Visible = true;
                openButton.Enabled = true;
            }
        }

        static string Describe(string state)
        {
            if (state == "RUNNING" || state == "OPEN_BROWSER") return "● Çalışıyor";
            if (state == "SHUTTING_DOWN") return "Durduruluyor...";
            if (state == "FAILED") return "Başlatılamadı";
            if (state == "START_APP" || state == "HEALTH_CHECK app" || state == "HEALTH_CHECK frontend") return "Uygulama başlatılıyor...";
            if (state == "START_DEPS" || state.StartsWith("HEALTH_CHECK")) return "Veritabanları başlatılıyor...";
            return "Hazırlanıyor...";
        }

        void OpenBrowser()
        {
            if (url == null) return;
            try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
        }

        void ShowFromOtherInstance()
        {
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            TopMost = true;
            TopMost = false;
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (!allowClose)
            {
                e.Cancel = true;
                if (!stopping) BeginStop();
                return;
            }
            closed = true;
            base.OnFormClosing(e);
        }

        void BeginStop()
        {
            stopping = true;
            status.Text = "Durduruluyor... (veritabanları kapatılıyor)";
            openButton.Enabled = false;
            stopButton.Enabled = false;
            UseWaitCursor = true;
            // Güvenlik ağı: launcher "stop"a hiç yanıt vermezse sonlandırılır.
            var watchdog = new System.Windows.Forms.Timer();
            watchdog.Interval = StopTimeoutMs;
            watchdog.Tick += (s, e) => { watchdog.Stop(); KillLauncher(); FinishClose(); };
            watchdog.Start();
            var stopper = new Thread(() =>
            {
                // Kontrol kanalı başlatmanın çok başında henüz açık olmayabilir: kısa süre tekrar dene.
                var retryUntil = DateTime.UtcNow.AddSeconds(15);
                while (Query("stop", 1000) == null)
                {
                    if (launcher == null || launcher.HasExited || DateTime.UtcNow > retryUntil) break;
                }
                if (launcher != null)
                {
                    try { if (!launcher.WaitForExit(20000)) KillLauncher(); } catch { }
                }
                try { BeginInvoke(new Action(FinishClose)); } catch { }
            });
            stopper.IsBackground = true;
            stopper.Start();
        }

        /// <summary>Launcher'ı sonlandırır; Job Object sayesinde alt süreçleri (DB'ler, app.exe) de kapanır.</summary>
        void KillLauncher()
        {
            try { if (launcher != null && !launcher.HasExited) launcher.Kill(); } catch { }
        }

        void FinishClose()
        {
            if (allowClose) return;
            allowClose = true;
            Close();
        }

        /// <summary>Launcher kontrol kanalına komut gönderir; bağlanılamazsa null.</summary>
        string Query(string command, int connectTimeoutMs)
        {
            try
            {
                using (var client = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut))
                {
                    client.Connect(connectTimeoutMs);
                    byte[] data = Encoding.UTF8.GetBytes(command + "\n");
                    client.Write(data, 0, data.Length);
                    client.Flush();
                    using (var reader = new StreamReader(client, Encoding.UTF8)) return reader.ReadToEnd();
                }
            }
            catch
            {
                return null;
            }
        }
    }
#else
    sealed class Progress
    {
        readonly string name;
        readonly ManualResetEvent finished = new ManualResetEvent(false);
        int last = -1;

        public Progress(string name)
        {
            this.name = name;
            Console.Error.Write(name + " ilk çalıştırma için hazırlanıyor...");
        }

        public void Report(long done, long total)
        {
            int pct = total > 0 ? (int)(done * 100 / total) : 0;
            if (pct == last || Console.IsErrorRedirected) return;
            last = pct;
            Console.Error.Write("\r" + name + " ilk çalıştırma için hazırlanıyor... %" + pct + "  ");
        }

        public void Done() { finished.Set(); }

        public void Run()
        {
            finished.WaitOne();
            Console.Error.WriteLine();
        }
    }
#endif

#if GUI
    /// <summary>96 DPI'ya göre piksel olarak yerleştirilen kontrolleri ekran DPI'sına ölçekler.</summary>
    static void ScaleForDpi(Form form)
    {
        using (var g = form.CreateGraphics())
        {
            float factor = g.DpiX / 96f;
            if (Math.Abs(factor - 1f) > 0.01f) form.Scale(new SizeF(factor, factor));
        }
    }
#endif

    /// <summary>Exe dosyasının içindeki payload bölgesini ayrı, aranabilir bir akış olarak sunar (ZipArchive için).</summary>
    sealed class SubStream : Stream
    {
        readonly Stream inner;
        readonly long start;
        readonly long length;
        long position;

        public SubStream(Stream inner, long start, long length)
        {
            this.inner = inner;
            this.start = start;
            this.length = length;
        }

        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return true; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return length; } }
        public override long Position
        {
            get { return position; }
            set { position = value; }
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            long remaining = length - position;
            if (remaining <= 0) return 0;
            if (count > remaining) count = (int)remaining;
            inner.Position = start + position;
            int n = inner.Read(buffer, offset, count);
            position += n;
            return n;
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            if (origin == SeekOrigin.Begin) position = offset;
            else if (origin == SeekOrigin.Current) position += offset;
            else position = length + offset;
            return position;
        }

        public override void Flush() { }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
    }
}

using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Windows.ApplicationModel;
using Windows.ApplicationModel.Activation;
using Windows.ApplicationModel.Background;
using Windows.Data.Json;
using Windows.Storage;
using Windows.UI.Core;
using Windows.UI.Notifications;
using Windows.UI.Notifications.Management;
using Windows.UI.Xaml;
using Windows.UI.Xaml.Controls;

namespace PocketListener
{
    sealed partial class App : Application
    {
        private const string BackgroundName = "PetPocket.WindowsAlerts";
        private const string Feed = "pet-alert.json";
        private readonly UserNotificationListener listener = UserNotificationListener.Current;
        private readonly DispatcherTimer timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
        private bool Connected => ApplicationData.Current.LocalSettings.Values.ContainsKey("connected");
        private CheckBox previews;
        private TextBlock status;
        private Button enable;
        private bool reading;
        private CoreDispatcher dispatcher;

        public App()
        {
            InitializeComponent();
            timer.Tick += async (_, __) => await Poll();
            Suspending += OnSuspending;
            Resuming += async (_, __) =>
            {
                if (dispatcher != null && Connected)
                    await dispatcher.RunAsync(CoreDispatcherPriority.Normal, () => timer.Start());
            };
        }

        protected override void OnLaunched(LaunchActivatedEventArgs args)
        {
            if (Window.Current.Content == null)
            {
                status = new TextBlock { Text = "Allow access to relay new Windows alerts to Pet Pocket.", TextWrapping = TextWrapping.Wrap };
                previews = new CheckBox
                {
                    Content = "Include message previews",
                    IsChecked = ApplicationData.Current.LocalSettings.Values["previews"] as bool? ?? false,
                };
                previews.Checked += (_, __) => ApplicationData.Current.LocalSettings.Values["previews"] = true;
                previews.Unchecked += (_, __) => ApplicationData.Current.LocalSettings.Values["previews"] = false;
                enable = new Button { Content = "Connect notifications" };
                enable.Click += async (_, __) =>
                {
                    enable.IsEnabled = false;
                    try
                    {
                        var access = await listener.RequestAccessAsync();
                        if (access == UserNotificationListenerAccessStatus.Allowed) await Start();
                        else Stop("Windows notification access is required. Check notification access in Settings.");
                    }
                    catch { Stop("Windows could not connect the notification listener."); }
                };
                var panel = new StackPanel { Padding = new Thickness(24), Spacing = 12 };
                panel.Children.Add(new TextBlock { Text = "Pet Pocket Notifications", FontSize = 24 });
                panel.Children.Add(status);
                panel.Children.Add(previews);
                panel.Children.Add(enable);
                Window.Current.Content = panel;
            }
            dispatcher = Window.Current.Dispatcher;
            Window.Current.Activate();
            if (Connected)
            {
                status.Text = "Connected. New alerts can be relayed while this window is minimized.";
                enable.IsEnabled = false;
                timer.Start();
            }
        }

        protected override async void OnBackgroundActivated(BackgroundActivatedEventArgs args)
        {
            var deferral = args.TaskInstance.GetDeferral();
            try { if (Connected) await Poll(); }
            finally { deferral.Complete(); }
        }

        private async Task Start()
        {
            var access = await BackgroundExecutionManager.RequestAccessAsync();
            if (access == BackgroundAccessStatus.DeniedByUser || access == BackgroundAccessStatus.DeniedBySystemPolicy)
            {
                Stop("Windows has disabled background activity for this app.");
                return;
            }
            var existing = await listener.GetNotificationsAsync(NotificationKinds.Toast);
            SaveSeen(existing.Select(item => item.Id));
            if (!BackgroundTaskRegistration.AllTasks.Values.Any(task => task.Name == BackgroundName))
            {
                var builder = new BackgroundTaskBuilder { Name = BackgroundName };
                builder.SetTrigger(new UserNotificationChangedTrigger(NotificationKinds.Toast));
                builder.Register();
            }
            ApplicationData.Current.LocalSettings.Values["connected"] = true;
            status.Text = "Connected. New alerts can be relayed while this window is minimized.";
            timer.Start();
        }

        private static void SaveSeen(IEnumerable<uint> ids)
        {
            ApplicationData.Current.LocalSettings.Values["seen"] = string.Join(",", ids.Take(256));
        }

        private void Stop(string message)
        {
            timer.Stop();
            ApplicationData.Current.LocalSettings.Values.Remove("connected");
            if (enable != null) enable.IsEnabled = true;
            if (status != null) status.Text = message;
        }

        private void OnSuspending(object sender, SuspendingEventArgs args)
        {
            timer.Stop();
        }

        private async Task Poll()
        {
            if (reading) return;
            reading = true;
            try
            {
                if (listener.GetAccessStatus() != UserNotificationListenerAccessStatus.Allowed)
                {
                    Stop("Notification access was turned off in Windows Settings.");
                    return;
                }
                var current = await listener.GetNotificationsAsync(NotificationKinds.Toast);
                var previous = new HashSet<string>((ApplicationData.Current.LocalSettings.Values["seen"] as string ?? "").Split(','));
                SaveSeen(current.Select(item => item.Id));
                var fresh = current.Where(item => !previous.Contains(item.Id.ToString()))
                    .OrderByDescending(item => item.CreationTime).Take(3).ToList();
                if (fresh.Count == 0) return;

                var newest = fresh[0];
                var source = newest.AppInfo.DisplayInfo.DisplayName;
                var binding = newest.Notification.Visual.GetBinding(KnownNotificationBindings.ToastGeneric);
                var message = (ApplicationData.Current.LocalSettings.Values["previews"] as bool? ?? false) && binding != null
                    ? string.Join(" · ", binding.GetTextElements().Select(item => item.Text).Where(text => !string.IsNullOrWhiteSpace(text)))
                    : "";
                if (message.Length > 220) message = message.Substring(0, 217) + "...";
                var alert = new JsonObject
                {
                    ["id"] = JsonValue.CreateStringValue(newest.Id + ":" + newest.CreationTime.ToUnixTimeMilliseconds()),
                    ["created"] = JsonValue.CreateNumberValue(newest.CreationTime.ToUnixTimeMilliseconds()),
                    ["source"] = JsonValue.CreateStringValue(source ?? "Windows"),
                    ["message"] = JsonValue.CreateStringValue(message),
                    ["count"] = JsonValue.CreateNumberValue(fresh.Count),
                };
                var temporary = await ApplicationData.Current.LocalFolder.CreateFileAsync(Feed + ".tmp", CreationCollisionOption.ReplaceExisting);
                await FileIO.WriteTextAsync(temporary, alert.Stringify());
                await temporary.RenameAsync(Feed, NameCollisionOption.ReplaceExisting);
            }
            catch { Stop("The notification connection was interrupted. Connect again to retry."); }
            finally { reading = false; }
        }
    }
}



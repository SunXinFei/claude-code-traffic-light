#!/usr/bin/env python3
"""
Claude Code 顶部栏红绿灯 —— Python 版
根据 Claude Code 会话状态显示：
- 绿灯常亮：会话进行中
- 黄灯闪烁：需要确认（等待权限）
- 红灯常亮：会话结束
"""
import json
import sys, os
if getattr(sys, 'frozen', False):
    os.chdir(os.path.dirname(sys.executable))
import shutil
import atexit
import signal
import time
import subprocess
import rumps
import psutil
from pathlib import Path

# ---------- 配置 ----------
BASE_DIR = os.path.expanduser("~/.claude/traffic_light")
STATE_DIR = BASE_DIR
CONFIG_PATH = os.path.expanduser("~/.claude/settings.json")
BACKUP_PATH = os.path.join(BASE_DIR, "settings_backup.json")
SELECTED_FILE = os.path.join(BASE_DIR, "selected_project")
POLL_INTERVAL = 0.3       # 轮询间隔（秒）
BLINK_INTERVAL = 0.5      # 闪烁间隔（秒）
MENU_REFRESH_INTERVAL = 2 # 菜单刷新间隔（秒），避免频繁重建

# 红绿灯相关的 hook 命令标识（用于清理旧条目）
TRAFFIC_MARKER = "traffic_light_app"

# 灯的符号
LIGHT_ON = {"red": "🔴", "yellow": "🟡", "green": "🟢"}
LIGHT_OFF = "⚫"


# ---------- Pin window (always-on-top) ----------
try:
    from AppKit import (
        NSWindow, NSTextField, NSBackingStoreBuffered, NSScreen,
        NSColor, NSFont, NSWindowStyleMaskBorderless,
        NSWindowCollectionBehaviorCanJoinAllSpaces, NSWindowCollectionBehaviorFullScreenAuxiliary, 
        NSFloatingWindowLevel, NSStatusWindowLevel, NSPopUpMenuWindowLevel,
    )
    # 尝试使用 Quartz 的光标层级（比 Maximum 层级更高）
    try:
        from Quartz import CGWindowLevelForKey, kCGCursorWindowLevelKey
        _CG_CURSOR_WINDOW_LEVEL = CGWindowLevelForKey(kCGCursorWindowLevelKey)
    except Exception:
        _CG_CURSOR_WINDOW_LEVEL = None

    # NSWindow 子类：处理双击事件
    class PinNSWindow(NSWindow):
        def mouseDown_(self, event):
            if event.clickCount() >= 2 and hasattr(self, '_on_double_click') and self._on_double_click:
                self._on_double_click()
                return
            super().mouseDown_(event)

        def hitTest_(self, point):
            # 所有鼠标事件都由窗口处理，不让子视图拦截
            return self

    class PinWindow:
        def __init__(self):
            screen = NSScreen.mainScreen()
            screen_frame = screen.frame()
            w, h = 72.0, 220.0  # 竖直长条
            x = 120.0
            y = screen_frame.size.height - h - 120.0
            frame = ((x, y), (w, h))

            # 使用 NSWindow 子类（支持双击事件）
            self.win = PinNSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
                frame, NSWindowStyleMaskBorderless, NSBackingStoreBuffered, False
            )
            self.win._on_double_click = self._on_double_click

            try:
                # Try CG cursor level first (highest practical level)
                try:
                    if _CG_CURSOR_WINDOW_LEVEL is not None:
                        self.win.setLevel_(_CG_CURSOR_WINDOW_LEVEL)
                    else:
                        raise Exception()
                except Exception:
                    try:
                        self.win.setLevel_(NSStatusWindowLevel)
                    except Exception:
                        try:
                            self.win.setLevel_(NSPopUpMenuWindowLevel)
                        except Exception:
                            self.win.setLevel_(NSFloatingWindowLevel)
                try:
                    # 在所有 Spaces 中可见并允许在全屏应用上显示
                    behavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary
                    self.win.setCollectionBehavior_(behavior)
                except Exception:
                    # 回退到之前的行为
                    try:
                        self.win.setCollectionBehavior_(NSWindowCollectionBehaviorCanJoinAllSpaces)
                    except Exception:
                        pass
                try:
                    # 允许通过窗口背景拖拽移动（支持 borderless 窗口）
                    self.win.setMovableByWindowBackground_(True)
                except Exception:
                    pass
            except Exception:
                pass

            self.win.setOpaque_(False)
            try:
                self.win.setBackgroundColor_(NSColor.clearColor())
            except Exception:
                pass

            # 使用毛玻璃效果作为浅黑色竖条背景
            try:
                from AppKit import NSVisualEffectView, NSVisualEffectMaterialDark, NSVisualEffectBlendingModeBehindWindow
                effect = NSVisualEffectView.alloc().initWithFrame_(frame)
                effect.setMaterial_(NSVisualEffectMaterialDark)
                effect.setBlendingMode_(NSVisualEffectBlendingModeBehindWindow)
                effect.setAutoresizingMask_(0x1F)
                effect.wantsLayer = True
                effect.layer().setCornerRadius_(12.0)
                # 在视觉效果上加一层半透明黑色覆盖以增深
                try:
                    overlay = NSTextField.alloc().initWithFrame_(((0, 0), (w, h)))
                    overlay.setBezeled_(False)
                    overlay.setDrawsBackground_(True)
                    overlay.setBackgroundColor_(NSColor.colorWithCalibratedWhite_alpha_(0.06, 0.85))
                    overlay.setEditable_(False)
                    overlay.setSelectable_(False)
                    overlay.setBordered_(False)
                    effect.addSubview_(overlay)
                except Exception:
                    pass
                self.win.contentView().addSubview_(effect)
            except Exception:
                # Fallback: use contentView layer background
                try:
                    content = self.win.contentView()
                    content.setWantsLayer_(True)
                    layer = content.layer()
                    try:
                        bg = NSColor.colorWithCalibratedRed_green_blue_alpha_(0.12, 0.12, 0.12, 0.85)
                        layer.setBackgroundColor_(bg.CGColor())
                    except Exception:
                        pass
                    try:
                        layer.setCornerRadius_(12.0)
                    except Exception:
                        pass
                except Exception:
                    pass

            # 三个灯竖向排列：红(上) 黄(中) 绿(下)
            content_view = self.win.contentView()
            self.lights = []
            light_size = 48.0
            spacing = 18.0
            total_h = light_size * 3 + spacing * 2
            start_y = (h - total_h) / 2.0 + (h - total_h) / 2.0  # center vertically
            # compute top position
            top_y = (h - total_h) / 2.0 + (total_h - light_size)
            for i in range(3):
                ly = (h - ((i + 1) * (light_size + spacing) - spacing)) - (h - total_h) / 2.0
                # simpler: place from top
                ly = h - ((i + 1) * (light_size + spacing)) + spacing / 2.0
                lx = (w - light_size) / 2.0
                lbl = NSTextField.alloc().initWithFrame_(((lx, ly), (light_size, light_size)))
                lbl.setStringValue_("⚫")
                lbl.setBezeled_(False)
                lbl.setDrawsBackground_(False)
                lbl.setEditable_(False)
                lbl.setSelectable_(False)
                try:
                    lbl.setAlignment_(1)  # NSCenterTextAlignment
                    lbl.setFont_(NSFont.systemFontOfSize_(36))
                except Exception:
                    pass
                content_view.addSubview_(lbl)
                self.lights.append(lbl)

        def show(self):
            try:
                self.win.orderFrontRegardless()
            except Exception:
                pass

        def hide(self):
            try:
                self.win.orderOut_(None)
            except Exception:
                pass

        def update(self, red="⚫", yellow="⚫", green="⚫"):
            try:
                self.lights[0].setStringValue_(red)
                self.lights[1].setStringValue_(yellow)
                self.lights[2].setStringValue_(green)
                self.win.displayIfNeeded()
            except Exception:
                pass

        def _on_double_click(self):
            print(">>> 双击触发！正在查找宿主应用...")
            activate_terminal_for_project(None)


except Exception as e:
    # Fallback stub when PyObjC / AppKit not available
    class PinWindow:
        def __init__(self):
            self._supported = False
        def show(self):
            pass
        def hide(self):
            pass
        def update(self, red="⚫", yellow="⚫", green="⚫"):
            pass


def get_state_file(project_name=None):
    """获取指定项目的状态文件路径"""
    if project_name is None:
        project_name = get_selected_project()
    return os.path.join(STATE_DIR, f"{project_name}.state")


def get_project_dir_file(project_name=None):
    """获取指定项目的目录文件路径"""
    if project_name is None:
        project_name = get_selected_project()
    return os.path.join(STATE_DIR, f"{project_name}.dir")


def _find_host_app_for_proc(proc):
    """沿进程树向上查找宿主 GUI 应用，返回 AppleScript 激活名称"""
    try:
        p = proc
        for _ in range(30):
            try:
                exe = p.exe()
                if '.app/' in exe:
                    return exe.split('.app/')[0].split('/')[-1]
            except (psutil.AccessDenied, psutil.NoSuchProcess):
                pass
            p = p.parent()
            if p is None:
                break
    except Exception:
        pass
    return None


def _activate_app(app_name):
    """激活应用：先试名称，再试常见 bundle ID"""
    try:
        result = subprocess.run(
            ['osascript', '-e', f'tell application "{app_name}" to activate'],
            capture_output=True, text=True, timeout=3)
        if result.returncode == 0:
            return True
    except Exception:
        pass
    bundle_id_map = {
        'iTerm': 'com.googlecode.iterm2',
        'Terminal': 'com.apple.Terminal',
        'Warp': 'dev.warp.Warp-Stable',
        'Visual Studio Code': 'com.microsoft.VSCode',
        'Cursor': 'com.todesktop.230313mzl4w4u92',
        'Windsurf': 'com.codeium.windsurf',
        'kitty': 'net.kovidgoyal.kitty',
        'Ghostty': 'com.mitchellh.ghostty',
        'Alacritty': 'io.alacritty',
    }
    bundle_id = bundle_id_map.get(app_name)
    if bundle_id:
        try:
            subprocess.run(
                ['osascript', '-e', f'tell application id "{bundle_id}" to activate'],
                capture_output=True, timeout=3)
            return True
        except Exception:
            pass
    return False


def _is_claude_proc(proc):
    """判断一个进程是否是 Claude Code 进程"""
    try:
        name = (proc.name() or "").lower()
        if "claude" in name:
            return True
        cmdline = proc.cmdline()
        cmdline_str = " ".join(cmdline).lower()
        if "claude-code" in cmdline_str:
            return True
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        pass
    return False


def activate_terminal_for_project(project_name=None):
    """双击图钉时，激活对应项目所在的宿主应用（终端/VSCode/Cursor 等）"""
    if project_name is None:
        project_name = get_selected_project()

    print(f">>> 激活项目: {project_name}")

    # 读取项目目录路径
    project_dir = None
    dir_file = get_project_dir_file(project_name)
    if Path(dir_file).exists():
        try:
            project_dir = Path(dir_file).read_text().strip()
        except Exception:
            pass
    print(f">>> 项目目录: {project_dir}")

    # 用 psutil 找到工作目录匹配的 Claude 进程，沿进程树找宿主应用
    try:
        for proc in psutil.process_iter(["pid", "name"]):
            try:
                if not _is_claude_proc(proc):
                    continue
                # 用 cwd 匹配项目
                if project_dir:
                    try:
                        cwd = proc.cwd()
                        if cwd != project_dir:
                            continue
                    except (psutil.AccessDenied, psutil.NoSuchProcess):
                        continue
                # 找到了匹配的 Claude 进程，沿进程树找宿主应用
                print(f">>> 找到 Claude 进程: pid={proc.pid} cwd={proc.cwd() if project_dir else 'N/A'}")
                app_name = _find_host_app_for_proc(proc)
                print(f">>> 宿主应用: {app_name}")
                if app_name:
                    if _activate_app(app_name):
                        return
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                continue
    except Exception:
        pass


def get_selected_project():
    """获取当前选中的项目名，默认选中第一个活跃项目"""
    try:
        if Path(SELECTED_FILE).exists():
            return Path(SELECTED_FILE).read_text().strip()
    except Exception:
        pass
    projects = list_active_projects()
    return projects[0] if projects else "default"


def set_selected_project(project_name):
    """设置当前选中的项目"""
    try:
        Path(SELECTED_FILE).parent.mkdir(parents=True, exist_ok=True)
        Path(SELECTED_FILE).write_text(project_name)
    except Exception:
        pass


def list_active_projects():
    """列出所有有状态文件的项目"""
    try:
        Path(STATE_DIR).mkdir(parents=True, exist_ok=True)
        return sorted(f.stem for f in Path(STATE_DIR).glob("*.state"))
    except Exception:
        return []


def backup_config():
    """备份原始配置文件"""
    if Path(CONFIG_PATH).exists():
        try:
            shutil.copy2(CONFIG_PATH, BACKUP_PATH)
            print(f"已备份原始配置: {BACKUP_PATH}")
            return True
        except Exception as e:
            print(f"备份配置失败: {e}")
    return True


def restore_config():
    """还原备份的配置文件并清理所有新增文件"""
    # 还原配置
    if Path(BACKUP_PATH).exists():
        try:
            shutil.copy2(BACKUP_PATH, CONFIG_PATH)
            Path(BACKUP_PATH).unlink()
            print(f"已还原原始配置: {CONFIG_PATH}")
        except Exception as e:
            print(f"还原配置失败: {e}")

    # 清理状态目录
    if Path(STATE_DIR).exists():
        try:
            shutil.rmtree(STATE_DIR)
            print(f"已清理状态目录: {STATE_DIR}")
        except Exception as e:
            print(f"清理状态目录失败: {e}")

    # 清理选择文件
    if Path(SELECTED_FILE).exists():
        try:
            Path(SELECTED_FILE).unlink()
            print(f"已清理选择文件: {SELECTED_FILE}")
        except Exception as e:
            print(f"清理选择文件失败: {e}")

    # 清理旧版单文件（兼容）
    old_file = os.path.expanduser("~/.claude/.traffic_light")
    if Path(old_file).exists():
        try:
            Path(old_file).unlink()
            print(f"已清理旧版状态文件: {old_file}")
        except Exception:
            pass


def _is_traffic_hook(entry):
    """判断一个 hook 条目是否属于红绿灯"""
    return any(TRAFFIC_MARKER in h.get("command", "") for h in entry.get("hooks", []))


def _make_hook_entry(command, matcher=""):
    """创建一个符合 Claude Code 格式的 hook 条目"""
    return {
        "matcher": matcher,
        "hooks": [{"type": "command", "command": command}],
    }


# ---------- 自动配置 Hook ----------
def configure_hooks():
    """安全地将所需的 hook 合并到 ~/.claude/settings.json"""
    Path(CONFIG_PATH).parent.mkdir(parents=True, exist_ok=True)
    Path(STATE_DIR).mkdir(parents=True, exist_ok=True)

    backup_config()

    # 读取现有配置
    config = {}
    if Path(CONFIG_PATH).exists():
        try:
            config = json.loads(Path(CONFIG_PATH).read_text())
        except Exception:
            config = {}

    hooks = config.get("hooks", {})
    if not isinstance(hooks, dict):
        hooks = {}

    # hook 命令：根据项目目录动态生成状态文件路径
    def _hook_cmd(state):
        marker = f"# {TRAFFIC_MARKER}"
        return (f'project=$(basename "${{CLAUDE_PROJECT_DIR:-$PWD}}") && mkdir -p {STATE_DIR} '
                f'&& echo {state} > {STATE_DIR}/"$project".state '
                f'&& echo "${{CLAUDE_PROJECT_DIR:-$PWD}}" > {STATE_DIR}/"$project".dir {marker}')

    # 只对需要权限的工具类型触发黄灯（扩大匹配）
    permission_tools = "Bash|Write|Edit|NotebookEdit|WebFetch|Read|Grep|Glob|mcp__"

    desired = {
        "SessionStart":       [_make_hook_entry(_hook_cmd("red"))],
        "UserPromptSubmit":   [_make_hook_entry(_hook_cmd("green"))],
        "PermissionRequest":  [_make_hook_entry(_hook_cmd("yellow"))],
        "PreToolUse":         [_make_hook_entry(_hook_cmd("green"), matcher=permission_tools)],
        "PostToolUse":        [_make_hook_entry(_hook_cmd("green"), matcher=permission_tools)],
        "Stop":               [_make_hook_entry(_hook_cmd("red"))],
        "StopFailure":        [_make_hook_entry(_hook_cmd("red"))],
        "SessionEnd":         [_make_hook_entry(_hook_cmd("red"))],
    }

    for hook_name, new_entries in desired.items():
        existing = hooks.get(hook_name, [])
        if not isinstance(existing, list):
            existing = []
        cleaned = [e for e in existing if not _is_traffic_hook(e)]
        cleaned.extend(new_entries)
        hooks[hook_name] = cleaned
        print(f"已设置 hook: {hook_name}")

    config["hooks"] = hooks
    try:
        Path(CONFIG_PATH).write_text(json.dumps(config, indent=2, sort_keys=True))
        print(f"Claude Code 配置已更新: {CONFIG_PATH}")
    except Exception as e:
        print(f"写入配置失败: {e}")


# ---------- 菜单栏应用 ----------
class TrafficLightApp(rumps.App):
    def __init__(self):
        super().__init__("", quit_button="退出")
        self.state = "red"
        self.blink_on = True
        self.selected_project = get_selected_project()
        self.last_projects = []         # 上次的项目列表，用于检测变化
        self.last_menu_build_time = 0   # 上次构建菜单的时间

        # 定时器
        rumps.Timer(self.check_state, POLL_INTERVAL).start()
        rumps.Timer(self.blink, BLINK_INTERVAL).start()

        # 读取 Claude 配置信息
        self.claude_info = self._load_claude_info()

        # Pin 窗口（可能为 stub）
        try:
            self.pin_window = PinWindow()
        except Exception:
            self.pin_window = None
        self.pin_shown = False

        # 初始化
        self._build_menu()
        self.update_display()

    def _load_claude_info(self):
        """读取 Claude 配置信息"""
        info = {"model": "未知"}
        try:
            if Path(CONFIG_PATH).exists():
                config = json.loads(Path(CONFIG_PATH).read_text())
                model = config.get("env", {}).get("ANTHROPIC_MODEL", "") or config.get("model", "未知")
                info["model"] = model
        except Exception:
            pass
        return info

    def _build_menu(self):
        """动态构建菜单"""
        self.menu.clear()

        # 项目选择
        project_menu = rumps.MenuItem("📁 选择项目")
        projects = list_active_projects()
        if not projects:
            item = rumps.MenuItem("  (无活跃项目)")
            item.set_callback(None)
            project_menu.add(item)
        else:
            for p in projects:
                item = rumps.MenuItem(f"  {p}")
                item.set_callback(self._on_select_project)
                if p == self.selected_project:
                    item.state = True
                project_menu.add(item)
        self.menu.add(project_menu)

        # 图钉（始终置顶窗口）
        pin_item = rumps.MenuItem("📌 图钉", callback=self._on_toggle_pin)
        pin_item.state = True if getattr(self, "pin_shown", False) else False
        self.menu.add(pin_item)

        # 当前项目信息
        self.menu.add(rumps.separator)
        self.menu.add(rumps.MenuItem("📊 当前项目", callback=None))
        self.menu.add(rumps.MenuItem(f"  项目: {self.selected_project}"))
        self.menu.add(rumps.MenuItem(f"  模型: {self.claude_info['model']}"))

        # 状态说明
        self.menu.add(rumps.separator)
        self.menu.add(rumps.MenuItem("状态说明", callback=None))
        self.menu.add(rumps.MenuItem("🟢 绿灯 - 会话进行中"))
        self.menu.add(rumps.MenuItem("🟡 黄灯闪烁 - 需要确认授权"))
        self.menu.add(rumps.MenuItem("🔴 红灯 - 会话结束"))

        self.last_projects = projects
        self.last_menu_build_time = time.time()

    def _on_select_project(self, sender):
        """项目选择回调"""
        self.selected_project = sender.title.strip()
        set_selected_project(self.selected_project)
        self.state = "red"
        self.blink_on = True
        self._build_menu()
        self.update_display()

    def _on_toggle_pin(self, sender):
        """切换图钉显示"""
        try:
            self.pin_shown = not getattr(self, "pin_shown", False)
            sender.state = True if self.pin_shown else False
            # 重新更新显示，确保菜单栏仍然显示
            self.update_display()
        except Exception as e:
            print(f"切换图钉失败: {e}")


    def check_state(self, _):
        """读取状态文件并更新状态"""
        state_file = get_state_file(self.selected_project)
        try:
            if Path(state_file).exists():
                content = Path(state_file).read_text().strip().lower()
                if content in ("red", "yellow", "green") and self.state != content:
                    self._set_state(content)
            else:
                if self.state != "red":
                    self._set_state("red")
        except Exception:
            pass

        # 定期刷新菜单（检测新项目），避免过于频繁
        now = time.time()
        if now - self.last_menu_build_time > MENU_REFRESH_INTERVAL:
            projects = list_active_projects()
            # 自动选中第一个项目（当前无选中或选中项已不存在时）
            if projects and (self.selected_project not in projects):
                self.selected_project = projects[0]
                set_selected_project(self.selected_project)
            if projects != self.last_projects:
                self._build_menu()

    def _set_state(self, new_state):
        """设置新状态并重置闪烁"""
        self.state = new_state
        self.blink_on = True

    def blink(self, _):
        """闪烁效果"""
        if self.state == "yellow":
            self.blink_on = not self.blink_on
        self.update_display()
        
        # 定期强制把窗口提升到最前（解决 VSCode/Chrome 全屏时被遮挡的问题）
        if self.pin_shown and hasattr(self, 'pin_window') and self.pin_window:
            try:
                self.pin_window.win.orderFrontRegardless()
                # 尝试使用 Accessibility API 进行额外的置顶
                try:
                    from AppKit import AXIsProcessTrusted
                    if AXIsProcessTrusted():
                        # 尝试让我们的进程前台化
                        from AppKit import NSApplication
                        app = NSApplication.sharedApplication()
                        app.activateIgnoringOtherApps_(True)
                except Exception:
                    pass
            except Exception:
                pass

    def update_display(self):
        """根据状态更新菜单栏显示"""
        lights = [LIGHT_OFF, LIGHT_OFF, LIGHT_OFF]
        
        if self.state == "green":
            # 绿灯常亮
            lights[2] = LIGHT_ON["green"]
        elif self.state == "yellow":
            # 黄灯闪烁
            lights[1] = LIGHT_ON["yellow"] if self.blink_on else LIGHT_OFF
        else:  # red
            # 红灯常亮
            lights[0] = LIGHT_ON["red"]
        
        self.title = " ".join(lights)

        # 同步到图钉窗口
        try:
            if getattr(self, "pin_shown", False) and self.pin_window:
                self.pin_window.update(red=lights[0], yellow=lights[1], green=lights[2])
                self.pin_window.show()
            elif self.pin_window:
                self.pin_window.hide()
        except Exception:
            pass


# ---------- 入口 ----------
def main():
    print("正在配置 Claude Code hooks...")
    configure_hooks()

    atexit.register(restore_config)

    def signal_handler(sig, frame):
        restore_config()
        sys.exit(0)

    signal.signal(signal.SIGINT, signal_handler)
    signal.signal(signal.SIGTERM, signal_handler)

    print("启动红绿灯监视器...")
    TrafficLightApp().run()


if __name__ == "__main__":
    main()

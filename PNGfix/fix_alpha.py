# -*- coding: utf-8 -*-
"""
AE 预乘黑底 PNG 修复工具（独立版，不依赖 After Effects）

用途
    After Effects 的 saveFrameToPng() 输出的是「预乘黑底」PNG：
    透明区的 RGB 被乘成了黑色，半透明区的颜色也被压暗。
    这种图在 AE 里（设了 PREMULTIPLIED）看着正常，
    但用 PS / 图片查看器打开就会发黑、半透明区偏暗。

    本工具把它转成标准「未预乘 (straight alpha)」PNG，
    这样任何软件打开都是正确的。

核心转换
    straight = premultiplied / (alpha / 255)

额外处理（去黑边）
    完全透明区（alpha=0）的原始颜色在预乘时已丢失。
    若不做处理，不支持 alpha 的查看器会显示成黑块。
    这里用「降采样取周围颜色再放大」的方式填充透明区，
    让不支持 alpha 的软件看到的也是内容色的延伸，而不是黑块。

用法
    单个/多个文件：          python fix_alpha.py a.png b.png
    整个文件夹：             python fix_alpha.py "D:\\some\\folder"
    自动监控文件夹(常驻)：   python fix_alpha.py --watch "D:\\some\\_raster_cache"
    静默模式(供脚本调用)：   python fix_alpha.py --silent a.png
    输出：                   直接覆盖原文件（不保留原图）。--silent / --watch 同理。
"""

import sys
import os
import time
import numpy as np
from PIL import Image


# ---- 窗口模式安全输出流 ----
# PyInstaller --noconsole 下，sys.stdout 的底层 buffer 可能是 None：
# 普通 print() 只是缓冲、不报错，但 sys.stdout.flush() 会真正去写那个
# None buffer，触发 "'NoneType' object has no attribute 'flush'" 崩溃
# （手动拖拽运行时尤其常见，因为走到了脚本末尾的 flush）。
# 用一层安全包装，把 write/flush/reconfigure 全部包成「失败即忽略」，
# 彻底避免窗口模式下因 stdout 不可用而崩溃。
class _SafeStream(object):
    def __init__(self, real):
        self._real = real

    def write(self, s):
        try:
            if self._real is not None:
                return self._real.write(s)
        except Exception:
            pass
        return 0

    def flush(self):
        try:
            if self._real is not None:
                self._real.flush()
        except Exception:
            pass

    def reconfigure(self, *a, **k):
        try:
            if self._real is not None:
                return self._real.reconfigure(*a, **k)
        except Exception:
            pass

    def isatty(self):
        return False

    def fileno(self):
        try:
            if self._real is not None:
                return self._real.fileno()
        except Exception:
            pass
        raise OSError("no fileno")


if sys.stdout is None or getattr(sys.stdout, "buffer", None) is None:
    sys.stdout = _SafeStream(sys.stdout)
if sys.stderr is None or getattr(sys.stderr, "buffer", None) is None:
    sys.stderr = _SafeStream(sys.stderr)


def bleed_transparent(rgb, mask, scale=16, iters=400):
    """
    用周围不透明像素的颜色填充透明区（去黑边）。

    做法：先在缩略图上做「迭代扩散」——从内容边缘一层层把颜色往外推，
    再放大回原尺寸。缩略图上迭代很快，能覆盖到大范围的空白区。

    rgb:  float32 [H,W,3]，透明区当前是 0
    mask: bool    [H,W]，True 表示不透明（颜色有效）
    返回：填充后的 rgb
    """
    h, w = mask.shape

    # 已经没有透明区，直接返回
    if mask.all():
        return rgb

    sh, sw = max(2, h // scale), max(2, w // scale)

    # ---- 降采样：算出每个 block 的平均颜色 ----
    masked_rgb = rgb * mask[:, :, None]
    sm_rgb = np.array(
        Image.fromarray(masked_rgb.astype(np.uint8), 'RGB').resize((sw, sh), Image.BOX),
        dtype=np.float32
    )
    sm_mask = np.array(
        Image.fromarray((mask.astype(np.uint8) * 255), 'L').resize((sw, sh), Image.BOX),
        dtype=np.float32
    ) / 255.0

    avg = np.zeros_like(sm_rgb)
    valid = sm_mask > 1e-4
    avg[valid] = sm_rgb[valid] / sm_mask[valid][:, None]
    avg = np.clip(avg, 0, 255)

    known = valid.copy()

    # 完全没有可参考颜色（整图全透明），放弃去黑边
    if not known.any():
        return rgb

    # ---- 在缩略图上迭代扩散：把颜色从已知区推向未知区 ----
    for _ in range(iters):
        if known.all():
            break
        new_avg = avg
        new_known = known
        for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
            src = np.roll(avg, (dy, dx), axis=(0, 1))
            src_known = np.roll(known, (dy, dx), axis=(0, 1))
            take = (~new_known) & src_known
            if take.any():
                new_avg = np.where(take[:, :, None], src, new_avg)
                new_known = new_known | take
        if new_known.sum() == known.sum():
            break          # 这一轮没有任何推进，提前结束
        avg, known = new_avg, new_known

    # 还没覆盖到的极端角落用全局平均兜底
    if not known.all():
        gmean = avg[valid].mean(axis=0) if valid.any() else np.zeros(3, np.float32)
        avg = np.where(known[:, :, None], avg, gmean)

    # ---- 放大回原尺寸，填充透明区 ----
    big = np.array(
        Image.fromarray(avg.astype(np.uint8), 'RGB').resize((w, h), Image.BILINEAR),
        dtype=np.float32
    )
    return np.where(mask[:, :, None], rgb, big)


def is_premultiplied_black(arr):
    """
    判断是否为「预乘黑底」图。

    预乘的本质：每个像素的 RGB 都已被 alpha 乘过，因此
    半透明像素的 RGB 绝不可能超过 255*alpha（即 alpha 允许的上限）。
    标准 straight 图里颜色与 alpha 无关，多数半透明像素会明显超过该上限。

    所以判据：在半透明像素中，统计「RGB 最大值 > 255*alpha*1.02」的比例，
    比例很低（< 20%）→ 判定为预乘黑底；比例高 → 标准透明，无需处理。
    """
    rgb = arr[:, :, :3]
    a = arr[:, :, 3].astype(np.float32) / 255.0

    semi = (a > 0.02) & (a < 0.98)
    if semi.sum() < 50:
        return None          # 半透明像素太少，无法判断

    r = rgb[:, :, 0][semi].astype(np.float32)
    g = rgb[:, :, 1][semi].astype(np.float32)
    b = rgb[:, :, 2][semi].astype(np.float32)
    mx = np.maximum(np.maximum(r, g), b)

    # 预乘：半透明处的最大通道值不会超过 255*alpha
    alpha_semi = (a[semi] * 255.0)
    exceed = mx > alpha_semi * 1.02      # 颜色比 alpha 允许的上限还亮 → 不是预乘
    frac_exceed = float(exceed.mean())
    return frac_exceed < 0.2


def process_one(path, do_bleed=True, replace=False, backup=True):
    """
    replace=False → 输出 原文件名_fixed.png（保留原图）
    replace=True  → 直接覆盖原文件（原图另存为 原文件名_原图.png 作备份）
    """
    img = Image.open(path)
    if img.mode != 'RGBA':
        img = img.convert('RGBA')

    arr = np.array(img, dtype=np.float32)
    rgb = arr[:, :, :3]
    a = arr[:, :, 3:4]
    mask = arr[:, :, 3] > 0

    # ---- 1. 预乘 → 未预乘 ----
    with np.errstate(divide='ignore', invalid='ignore'):
        straight = rgb / (a / 255.0)
    straight = np.where(a > 0, straight, 0.0)
    straight = np.clip(straight, 0, 255)

    # ---- 2. 去黑边（填充完全透明区）----
    if do_bleed and not mask.all():
        straight = bleed_transparent(straight, mask)

    out_arr = np.concatenate([straight, a], axis=2).astype(np.uint8)
    result = Image.fromarray(out_arr, 'RGBA')

    base, _ = os.path.splitext(path)

    if not replace:
        out_path = base + "_fixed.png"
        result.save(out_path, 'PNG')
        return out_path, None

    # ---- 替换模式：先写临时文件，成功后再动原文件 ----
    tmp_path = base + ".tmp_fixing.png"
    result.save(tmp_path, 'PNG')

    bak_path = None
    if backup:
        bak_path = base + "_原图.png"
        if not os.path.exists(bak_path):
            os.replace(path, bak_path)      # 原图改名备份
        else:
            os.remove(path)                 # 备份已存在，移除原图

    # 临时文件 → 原路径。backup=False 时原图被直接覆盖掉。
    # 用 os.replace 而非「先删后建」：中途失败也不会把文件搞丢。
    os.replace(tmp_path, path)
    return path, bak_path


def collect_files(paths):
    """展开文件夹，收集所有 png（排除已修复的 _fixed 和备份 _原图）"""
    skip = ('_fixed.png', '_原图.png', '.tmp_fixing.png')
    out = []
    for p in paths:
        if os.path.isdir(p):
            for root, _, files in os.walk(p):
                for f in files:
                    fl = f.lower()
                    if fl.endswith('.png') and not any(fl.endswith(s) for s in skip):
                        out.append(os.path.join(root, f))
        elif os.path.isfile(p) and p.lower().endswith('.png'):
            if not any(p.lower().endswith(s) for s in skip):
                out.append(p)
    return out


def reveal_in_explorer(path):
    """在资源管理器中定位并选中文件，避免用户找不到输出"""
    try:
        import subprocess
        subprocess.Popen(['explorer', '/select,', os.path.normpath(os.path.abspath(path))])
    except Exception:
        pass


def run_watch(folder):
    """常驻监控文件夹：新出现的 PNG 自动转为标准透明 (straight alpha)。"""
    folder = os.path.abspath(folder)
    if not os.path.isdir(folder):
        print("监控目录不存在:", folder)
        return
    print("=" * 46)
    print("  文件夹自动监控已启动")
    print("  目录:", folder)
    print("  新出现的 PNG 会自动修复为「标准透明」")
    print("  按 Ctrl+C 可停止")
    print("=" * 46)
    processed = set()
    while True:
        try:
            for f in os.listdir(folder):
                fl = f.lower()
                if not fl.endswith('.png'):
                    continue
                if fl.endswith(('_fixed.png', '_原图.png', '.tmp_fixing.png')):
                    continue
                fp = os.path.join(folder, f)
                if fp in processed:
                    continue
                try:
                    # 还在写入中（最近 1 秒内改过）则跳过，等稳定后再处理
                    if time.time() - os.path.getmtime(fp) < 1.0:
                        continue
                except Exception:
                    continue
                try:
                    arr = np.array(Image.open(fp).convert('RGBA'))
                    premul = is_premultiplied_black(arr)
                    if premul is False:
                        print("[跳过] 已是非预乘: %s" % f)
                        processed.add(fp)
                        continue
                    process_one(fp, do_bleed=True, replace=True, backup=False)
                    print("[已修复] %s" % f)
                    processed.add(fp)
                except Exception as e:
                    print("[失败] %s  (%s)" % (f, e))
                    processed.add(fp)   # 避免同一文件无限重试
            time.sleep(2)
        except KeyboardInterrupt:
            print("\n已停止监控。")
            break
        except Exception:
            time.sleep(2)


def _write_done(donefile, status):
    """写完成标记文件，供 SY_Merge 轮询（后台非阻塞修复用）。"""
    if not donefile:
        return
    try:
        with open(donefile, 'w', encoding='utf-8') as fh:
            fh.write((status or "") + "\n")
    except Exception:
        pass


def main():
    # 修正 Windows 拖拽时的编码问题：
    # 用 utf-8 + 容错（之前用 mbcs 会让绿色 ANSI 码的 \x1b 字符抛编码异常）
    try:
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
        sys.stderr.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass

    # 绿色输出（用 Windows API 设控制台颜色，绕过 ANSI 码的 mbcs 编码问题）
    def _print_green(s):
        if sys.platform == 'win32':
            try:
                import ctypes
                kernel32 = ctypes.windll.kernel32
                h = kernel32.GetStdHandle(-11)
                kernel32.SetConsoleTextAttribute(h, 0x0A)   # 亮绿前景
                print(s)
                kernel32.SetConsoleTextAttribute(h, 0x07)   # 恢复默认
            except Exception:
                print(s)
        else:
            print(s)

    # ---- 解析参数：--silent（脚本调用，无交互）、--watch <目录>（常驻监控）
    #   --pathfile <文件>：文件里每行一个路径（utf-8 写入，支持中文/特殊字符）。
    #   用于 ExtendScript 的 system.callSystem —— 它在 Windows 下走 ANSI 代码页，
    #   命令行里带中文的路径会被截乱；把路径写进纯 ASCII 临时文件再让 Python 读回，
    #   就能完整保留中文/「?」等特殊字符。
    silent = False
    watch_dir = None
    pathfile = None
    donefile = None
    paths = []
    i = 0
    while i < len(sys.argv):
        a = sys.argv[i]
        if a == '--silent':
            silent = True
        elif a == '--pathfile':
            i += 1
            pathfile = sys.argv[i] if i < len(sys.argv) else None
        elif a == '--donefile':
            i += 1
            donefile = sys.argv[i] if i < len(sys.argv) else None
        elif a == '--watch':
            i += 1
            watch_dir = sys.argv[i] if i < len(sys.argv) else None
        else:
            paths.append(a)
        i += 1

    if watch_dir:
        run_watch(watch_dir)
        return

    # 若走 --pathfile：从文件读取真实路径（utf-8，每行一个），支持中文/特殊字符。
    # 这能绕过 ExtendScript 在命令行里传中文路径被截乱的问题。
    if pathfile:
        try:
            with open(pathfile, 'r', encoding='utf-8') as fh:
                for line in fh:
                    line = line.strip()
                    if line:
                        paths.append(line)
        except Exception as e:
            if not silent:
                print("读取路径文件失败: %s (%s)" % (pathfile, e))
            return

    if not paths:
        if not silent:
            print("=" * 46)
            print("  请把 PNG 图片「拖到」本程序的图标上")
            print("  注意：是拖拽，不是双击打开！")
            print("=" * 46)
            try:
                input("\n按回车键退出...")
            except Exception:
                pass
        _write_done(donefile, "SYFIX:ERR")
        return

    files = collect_files(paths)
    if not files:
        if not silent:
            print("没有找到 PNG 文件（只找 .png，且跳过已带 _fixed 的）")
            try:
                input("按回车键退出...")
            except Exception:
                pass
        return

    if not silent:
        print("共 %d 个文件待处理" % len(files))
        print("模式：直接覆盖原文件，原图不保留（不可恢复）\n")

    ok = 0
    outputs = []
    for idx, f in enumerate(files, 1):
        name = os.path.basename(f)
        try:
            arr_hint = np.array(Image.open(f).convert('RGBA'))
            premul = is_premultiplied_black(arr_hint)
            if premul is False:
                if not silent:
                    print("[%d/%d] 跳过（已是非预乘，无需修复）: %s" % (idx, len(files), name))
                continue
            process_one(f, do_bleed=True, replace=True, backup=False)
            outputs.append(f)
            tag = "预乘黑底" if premul else "不确定，已按预乘处理"
            if not silent:
                print("[%d/%d] 已修复并覆盖(%s): %s" % (idx, len(files), tag, name))
            ok += 1
        except Exception as e:
            if not silent:
                print("[%d/%d] 失败: %s  (%s)" % (idx, len(files), name, e))

    if silent:
        # 给调用方（SY_Merge）一个可解析的结果标记：
        #   SYFIX:OK   —— 至少修复了一个（文件已转为 straight alpha）
        #   SYFIX:SKIP —— 全部已是非预乘（文件本身就是 straight，无需改）
        #   （无标记）  —— 调用/处理失败，调用方应回退到原「预乘」逻辑
        status = "SYFIX:OK" if ok > 0 else "SYFIX:SKIP"
        print(status)
        _write_done(donefile, status)   # 让 SY_Merge 轮询结束（OK/SKIP 都切 STRAIGHT）
        return

    print("\n" + "=" * 46)
    print("完成：成功修复 %d 个" % ok)
    print("原文件已被修复版覆盖，仅保留处理后的图")
    print("（原图是脚本生成的，需要的话可从 AE 重新导出）")
    print("=" * 46)

    # 自动弹出文件所在位置，避免"生成了但没看到"
    if outputs:
        print("\n正在打开输出文件所在文件夹...")
        reveal_in_explorer(outputs[-1] if len(outputs) == 1 else os.path.dirname(outputs[-1]))

    # 绿色"处理完毕"作为明确完成信号
    _print_green("\n✓ 处理完毕")
    try:
        sys.stdout.flush()
    except Exception:
        pass

    # 关键：处理完全结束后再停留几秒才退出。
    # 放在 Python 里 sleep 而不是交给 bat 的 timeout 命令——
    # 因为 cmd 是逐行阻塞的，Python 没跑完就不会走到下一行，
    # 所以「处理中途窗口关闭」在结构上不可能发生。
    time.sleep(3)


if __name__ == '__main__':
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        # 任何未预期异常都写日志到 %TEMP%/SY_Merge_fix_err.log，方便排查，
        # 不再弹出易误导的 PyInstaller 崩溃框（窗口模式无控制台）。
        try:
            import traceback as _tb
            _log = open(os.path.join(os.environ.get("TEMP", os.getcwd()),
                                     "SY_Merge_fix_err.log"), "a", encoding="utf-8")
            _log.write("[%s]\n" % time.strftime("%Y-%m-%d %H:%M:%S"))
            _tb.print_exc(file=_log)
            _log.write("\n")
            _log.close()
        except Exception:
            pass
        sys.exit(1)

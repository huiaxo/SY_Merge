// ============================================================
// SY_Merge.jsx  —— 合并图层（面板 + 自动安装快捷键脚本）
// 放到 ScriptUI Panels 目录，重启 AE 后从 Window 菜单打开
// 快捷键：在「编辑 > 键盘快捷方式」搜索 SY_Merge_Run 绑定 Ctrl+Tab
// ============================================================

(function (thisObj) {

    // ====== 自动安装快捷键触发脚本 ======
    // AE 只能给 Scripts 目录下的脚本绑快捷键，
    // 所以面板首次加载时自动在那里写一个极小的触发文件。
    function autoInstallRunner() {
        try {
            var panelFile = new File($.fileName);  // 当前面板文件路径
            var scriptsDir = new Folder(panelFile.parent.parent.fsName);  // Scripts 目录
            var runnerFile = new File(scriptsDir.fsName + "/SY_Merge_Run.jsx");
            var code = '// \u7531 SY_Merge.jsx \u81EA\u52A8\u751F\u6210\uFF0C\u8BF7\u52FF\u624B\u52A8\u4FEE\u6539\n'
                     + '// \u5728\u300C\u7F16\u8F91 > \u952E\u76D8\u5FEB\u6377\u65B9\u5F0F\u300D\u4E2D\u641C\u7D22 SY_Merge_Run \u7ED1\u5B9A Ctrl+Tab\n'
                     + '(function(){\n'
                     + '    if(typeof $.global._doMergeLayers === "function"){\n'
                     + '        $.global._doMergeLayers();\n'
                     + '    } else {\n'
                     + '        alert("[SY_Merge] \\u8BF7\\u5148\\u4ECE Window \\u83DC\\u5355\\u6253\\u5F00\\u4E00\\u6B21 SY_Merge \\u9762\\u677F\\u3002");\n'
                     + '    }\n'
                     + '})();\n';

            // 只在文件不存在或内容变化时才写入
            var needWrite = true;
            if (runnerFile.exists) {
                runnerFile.open("r");
                var existing = runnerFile.read();
                runnerFile.close();
                if (existing === code) needWrite = false;
            }
            if (needWrite) {
                runnerFile.open("w");
                runnerFile.write(code);
                runnerFile.close();
            }
        } catch (e) {
            // 静默，不影响面板正常使用
        }
    }

    // ====== PNG 完整性检测 ======
    // PNG 文件结尾固定是 IEND 块（12 字节：00 00 00 00 | 'IEND' | AE 42 60 82）
    // 只要读到它，就说明 PNG 已完整落盘。
    // 比"文件大小稳定"可靠得多——写入中途短暂停顿也不会误判。
    function pngIsComplete(path) {
        var f = null;
        try {
            f = new File(path);
            if (!f.exists || f.length < 12) return false;
            f.encoding = "BINARY";
            if (!f.open("r")) return false;
            f.seek(f.length - 12);      // 跳到末尾 12 字节
            var tail = f.read(12);
            f.close();
            f = null;
            if (!tail || tail.length < 12) return false;
            // 第 5~8 字节应为 "IEND"
            return (tail.charCodeAt(4) === 0x49 &&   // I
                    tail.charCodeAt(5) === 0x45 &&   // E
                    tail.charCodeAt(6) === 0x4E &&   // N
                    tail.charCodeAt(7) === 0x44);    // D
        } catch (e) {
            try { if (f) f.close(); } catch (e2) {}
            return false;
        }
    }

    // ====== 非阻塞轮询：等 PNG 完整写入 ======
    // 用 app.scheduleTask 让出主线程——等待期间 AE 界面不冻结，
    // 后台写入线程也不必跟主线程抢资源，可能因此写得更顺。
    // 天然兼容同步 / 异步 saveFrameToPng：
    //   同步 → 第一次回调就命中 IEND，零延迟
    //   异步 → 持续每 50ms 回调检查，写完立即收尾
    function pollAndImport() {
        var a = $.global._syMergeArgs;
        if (!a) return;

        a.tries = (a.tries || 0) + 1;

        // ① 最可靠：PNG 结构完整（读到 IEND）
        if (pngIsComplete(a.pngPath)) {
            finishImport(a);
            return;
        }

        // ② 兜底：文件大小连续 10 次（约 500ms）没变化，认为写完
        try {
            var f = new File(a.pngPath);
            if (f.exists && f.length > 0) {
                if (f.length === a.lastSize) {
                    a.stable = (a.stable || 0) + 1;
                    if (a.stable >= 10) {
                        finishImport(a);
                        return;
                    }
                } else {
                    a.stable = 0;
                    a.lastSize = f.length;
                }
            }
        } catch (e) {}

        // ③ 还没好 → 让出主线程，50ms 后再查（200 次 ≈ 10 秒上限）
        if (a.tries < 200) {
            app.scheduleTask("$.global._syMergeImport();", 50, false);
            return;
        }

        // ④ 超时兜底：最后尝试一次
        finishImport(a);
    }

    // ====== PNG 就绪后的收尾：隐藏预合成 + 导入 + 定位 ======
    function finishImport(a) {
        app.beginUndoGroup("SY Merge - Import");
        try {
            var comp = null;
            var preComp = null;
            for (var i = 1; i <= app.project.numItems; i++) {
                var itm = app.project.item(i);
                if (itm.id === a.compId) comp = itm;
                if (itm.id === a.preCompId) preComp = itm;
            }
            if (!preComp && a.preCompName) {
                for (var j = 1; j <= app.project.numItems; j++) {
                    var itm2 = app.project.item(j);
                    if (itm2 instanceof CompItem && itm2.name === a.preCompName) {
                        preComp = itm2;
                        break;
                    }
                }
            }
            if (!comp) { alert("[SY_Merge] \u627E\u4E0D\u5230\u539F\u5408\u6210\u3002"); return; }

            // ---- Step 1: 隐藏临时预合成图层（shy + 不可见），不删除 ----
            if (preComp) {
                for (var k = comp.numLayers; k >= 1; k--) {
                    try {
                        if (comp.layer(k).source === preComp) {
                            comp.layer(k).enabled = false;
                            comp.layer(k).shy = true;
                            break;
                        }
                    } catch (e2) {}
                }
            }

            // ---- Step 2: 导入 PNG（少量重试）----
            // PNG 已完整，importFile 基本一次成功；
            // 保留 5 次极短重试以防 media I/O 管线偶发延迟
            var footage = null;
            var lastErr = null;
            for (var attempt = 0; attempt < 5; attempt++) {
                try {
                    var io = new ImportOptions(new File(a.pngPath));
                    io.importAs = ImportAsType.FOOTAGE;
                    footage = app.project.importFile(io);
                    a.footageId = footage.id;   // 记下 ID，供合并完成后修复时定位
                    break;
                } catch (importErr) {
                    lastErr = importErr;
                    if (attempt < 4) $.sleep(30);
                }
            }

            if (!footage) {
                var errMsg = lastErr ? lastErr.toString() : "PNG \u672A\u80FD\u843D\u5730";
                alert("[SY_Merge] \u5BFC\u5165\u5931\u8D25\uFF1A\n" + errMsg +
                      "\n\n\u8DEF\u5F84\uFF1A" + a.pngPath +
                      "\n\u9884\u5408\u6210\u5DF2\u4FDD\u7559\uFF0C\u4F60\u53EF\u4EE5\u624B\u52A8\u5BFC\u5165\u3002");
                return;
            }

            // ---- Step 3: 设置 footage 属性（与原脚本完全一致）----
            // 【重要，不要删】saveFrameToPng 输出的是「预乘黑底」PNG，
            // 必须显式告诉 AE 用 PREMULTIPLIED + 黑色，否则 AE 会按默认的
            // straight alpha 解读，把本该透明的像素渲染成黑色（发黑）。
            footage.name = a.mergeName;
            try {
                if (footage.mainSource.hasAlpha) {
                    footage.mainSource.alphaMode = AlphaMode.PREMULTIPLIED;
                    footage.mainSource.premulColor = [0, 0, 0];
                }
            } catch (alphaErr) {}

            // ---- Step 4: 添加到合成并定位 ----
            // 用锚点图层 ID 定位（precompose 后索引会变化，但 ID 不变）
            var newLayer = comp.layers.add(footage);
            newLayer.name = a.mergeName;
            try {
                if (a.anchorLayerId > 0) {
                    // 锚点是原 topIndex 上方的图层，新图层应放在锚点的下方（after）
                    for (var li = 1; li <= comp.numLayers; li++) {
                        if (comp.layer(li).id === a.anchorLayerId) {
                            newLayer.moveAfter(comp.layer(li));
                            break;
                        }
                    }
                } else {
                    // 原来选中的就是最顶部的图层，新图层放到最顶部
                    newLayer.moveToBeginning();
                }
            } catch (e0) {}

            // ---- Step 5: 开启合成的"消隐"开关 ----
            try { comp.hideShyLayers = true; } catch (eShy) {}

            // ---- Step 6: 合并已完成，把「透明修复」延后到合并收尾之后再做 ----
            // 目的：合并过程（写盘→轮询→导入→放置）完全不变、不卡 UI；
            // 修复在合并结束后才触发，仅在这一步有约 1 秒的同步调用（after merge）。
            if (a.autoFix && a.footageId) {
                $.global._syMergePostFixArgs = {
                    pngPath: a.pngPath,
                    footageId: a.footageId
                };
                _fixLog("schedule postFix: autoFix=" + a.autoFix + " footId=" + a.footageId + " png=" + a.pngPath);
                app.scheduleTask("$.global._syMergePostFix();", 80, false);
            } else {
                _fixLog("postFix NOT scheduled: autoFix=" + a.autoFix + " footId=" + a.footageId);
            }

        } catch (err) {
            alert("[SY_Merge] \u5BFC\u56DE\u51FA\u9519: " + err.toString() +
                  (err.line ? "  (line " + err.line + ")" : ""));
        } finally {
            app.endUndoGroup();
            $.global._syMergeArgs = null;
        }
    }

    $.global._syMergeImport = pollAndImport;

    // ====== 外部工具路径：自动解析（完全自包含，拷贝即用）======
    // 三层优先级：
    //   ①【首选】PNGfix 文件夹内自带的便携 Python（PNGfix/python/python.exe）
    //      —— 把整个 PNGfix 文件夹拷到任何电脑都能用，目标机无需安装 Python。
    //   ② 回退：WorkBuddy 管理的 venv（本机 / 同用户名机器，%USERPROFILE% 自动拼）。
    //   ③ 兜底：旧硬编码绝对路径（兼容极老布局）。
    // 推荐做法：把 PNGfix 文件夹直接放在 SY_Merge.jsx 所在的 ScriptUI Panels 目录里，
    // 这样拷到任何电脑都自动认得，无需改任何常量、也无需装 Python。
    function _resolveFixPy() {
        // ① 完全自包含：PNGfix 自带便携 Python（拷贝即用）
        try {
            var self = new File($.fileName);
            var dir = self.parent;                  // ScriptUI Panels
            var cands = [];
            cands.push(dir.fsName + "\\PNGfix\\python\\python.exe");        // 同级 PNGfix/python
            cands.push(dir.parent.fsName + "\\PNGfix\\python\\python.exe"); // 上级目录 PNGfix/python
            for (var i = 0; i < cands.length; i++) {
                try { if (new File(cands[i]).exists) return cands[i]; } catch (eC) {}
            }
        } catch (e) {}
        // ② 回退 WorkBuddy venv（%USERPROFILE% 任意用户名都认）
        try {
            var up = $.getenv("USERPROFILE") || "";
            if (up) {
                var p = up.split("/").join("\\") + "\\.workbuddy\\binaries\\python\\envs\\default\\Scripts\\python.exe";
                if (new File(p).exists) return p;
            }
        } catch (e2) {}
        return "C:/Users/huaxiaohui/.workbuddy/binaries/python/envs/default/Scripts/python.exe"; // 兜底旧路径
    }

    function _resolveFixExe() {
        // 完全自包含：优先用 PNGfix 里的 fix_alpha.exe（单文件，无需 python 文件夹）
        var cands = [];
        try {
            var self = new File($.fileName);
            var dir = self.parent;                 // ScriptUI Panels
            cands.push(dir.fsName + "\\PNGfix\\fix_alpha.exe");          // 同级 PNGfix/
            cands.push(dir.parent.fsName + "\\PNGfix\\fix_alpha.exe");   // 上级目录 PNGfix/
        } catch (e) {}
        try {
            var up = $.getenv("USERPROFILE") || "";
            if (up) cands.push(up.split("/").join("\\") + "\\Desktop\\PNGfix\\fix_alpha.exe");
        } catch (e) {}
        cands.push("C:/Users/huaxiaohui/Desktop/PNGfix/fix_alpha.exe");  // 旧硬编码兜底
        for (var i = 0; i < cands.length; i++) {
            try { if (new File(cands[i]).exists) return cands[i]; } catch (e2) {}
        }
        return "";   // 没找到 exe → 走 python 回退
    }

    function _resolveFixScript() {
        var cands = [];
        try {
            var up = $.getenv("USERPROFILE") || "";
            if (up) cands.push(up.split("/").join("\\") + "\\Desktop\\PNGfix\\fix_alpha.py");
        } catch (e) {}
        try {
            var self = new File($.fileName);
            var dir = self.parent;                 // ScriptUI Panels
            cands.push(dir.fsName + "\\PNGfix\\fix_alpha.py");          // 同级 PNGfix/
            cands.push(dir.parent.fsName + "\\PNGfix\\fix_alpha.py");   // 上级目录 PNGfix/
        } catch (e) {}
        cands.push("C:/Users/huaxiaohui/Desktop/PNGfix/fix_alpha.py");  // 旧硬编码兜底
        for (var i = 0; i < cands.length; i++) {
            try { if (new File(cands[i]).exists) return cands[i]; } catch (e2) {}
        }
        return cands[0];   // 都找不到就返回第一个（sc.exists=false → 跳过，日志可见）
    }

    var SY_FIX_PY = _resolveFixPy();
    var SY_FIX_SCRIPT = _resolveFixScript();
    var SY_FIX_EXE = _resolveFixExe();
    _fixLog("resolved: EXE=" + SY_FIX_EXE + " | PY=" + SY_FIX_PY + " | SCRIPT=" + SY_FIX_SCRIPT);

    // 调试日志：写到系统临时目录 SY_Merge_fix.log，便于排查「没调用成功」时到底发生了什么
    function _fixLog(s) {
        try {
            var log = new File(Folder.temp.fsName + "/SY_Merge_fix.log");
            log.open("a");
            log.writeln("[" + (new Date()).toLocaleTimeString() + "] " + s);
            log.close();
        } catch (eL) {}
    }

    // ====== 后台启动外部工具（不阻塞 AE）======
    // 关键：用 WScript.Shell.Run(..., 0, false) —— 0=隐藏窗口，false=「不等待子进程」，
    // 进程在 AE 之外异步跑，AE 立刻返回，UI 完全不卡；若 AE 不支持 ActiveXObject，
    // 回退到 cmd /c start（start 立即返回，仅阻塞约 100ms）。
    // 每个文件配一个独立的「完成标记文件」donefile（纯 ASCII），工具处理完写入
    // SYFIX:OK / SYFIX:SKIP；AE 用 scheduleTask 轮询该标记，出现后再把 footage 切到
    // STRAIGHT 并 reload，从而与 PS / 查看器一致。返回 donefile 路径，失败返回 null。
    function syFixLaunch(pngPath) {
        try {
            // 真实 png 路径写入纯 ASCII 临时文件（utf-8），避免命令行传中文被截乱
            var tmpFile = new File(Folder.temp.fsName + "/SY_Merge_pathfile.txt");
            tmpFile.encoding = "UTF-8";
            try { tmpFile.open("w"); tmpFile.write(pngPath); tmpFile.close(); } catch (eW) { _fixLog("temp write fail"); return null; }
            var tmpPath = tmpFile.fsName.split("/").join("\\");

            // 每个启动配一个唯一完成标记文件（支持连续多次合并）
            var stamp = (new Date()).getTime() + "_" + Math.floor(Math.random() * 100000);
            var doneFile = new File(Folder.temp.fsName + "/SY_Merge_done_" + stamp + ".txt");
            var donePath = doneFile.fsName.split("/").join("\\");

            _fixLog("launch begin: " + pngPath);

            // ① 优先：完全自包含 fix_alpha.exe（无需 python 文件夹，拷贝即用）
            if (SY_FIX_EXE && new File(SY_FIX_EXE).exists) {
                var exeCmd = SY_FIX_EXE.split("/").join("\\");
                var exeArgs = '--silent --pathfile "' + tmpPath + '" --donefile "' + donePath + '"';
                var r = _syLaunchDetached(exeCmd, exeArgs, donePath, pngPath, "exe");
                if (r) return r;
            }

            // ② 回退：python + fix_alpha.py（老布局 / 开发用；本机有 venv 时也行）
            var py = new File(SY_FIX_PY);
            var sc = new File(SY_FIX_SCRIPT);
            if (!py.exists || !sc.exists) {
                _fixLog("skip: 工具缺失 py=" + py.exists + " sc=" + sc.exists + " (exe 也未找到)");
                return null;
            }
            var pyCmd = SY_FIX_PY.split("/").join("\\");
            var scCmd = SY_FIX_SCRIPT.split("/").join("\\");
            var pyArgs = '"' + scCmd + '" --silent --pathfile "' + tmpPath + '" --donefile "' + donePath + '"';
            return _syLaunchDetached(pyCmd, pyArgs, donePath, pngPath, "py");
        } catch (e) {
            _fixLog("launch exception: " + e.toString());
            return null;
        }
    }

    // 三档异步启动：优先 Shell.Application.ShellExecute，回退 WScript.Shell.Run，最后 system.callSystem。
    // 均把子进程 stdout/stderr 重定向到 NUL，断开采 AE 与子进程的管道，AE 主线程绝不等待。
    function _syLaunchDetached(prog, args, donePath, pngPath, tag) {
        // ① Shell.Application.ShellExecute（Windows Shell 异步点火，不建管道）
        try {
            var sa = new ActiveXObject("Shell.Application");
            sa.ShellExecute(prog, args, Folder.temp.fsName, "open", 0);  // 0=隐藏窗口
            _fixLog("launched detached (ShellExecute-" + tag + "): " + pngPath);
            return donePath;
        } catch (eShell) {}
        // ② WScript.Shell.Run + cmd /c start >NUL（彻底脱离 AE，断开管道）
        try {
            var shell = new ActiveXObject("WScript.Shell");
            var cmd = 'cmd.exe /c start "" /MIN "' + prog + '" ' + args + ' >NUL 2>&1';
            shell.Run(cmd, 0, false);
            _fixLog("launched detached (WScript-" + tag + "): " + pngPath);
            return donePath;
        } catch (eActive) {}
        // ③ system.callSystem + start >NUL（最后回退）
        try {
            var cmd2 = 'cmd.exe /c start "" /MIN "' + prog + '" ' + args + ' >NUL 2>&1';
            system.callSystem(cmd2);
            _fixLog("launched detached (cmd-" + tag + "): " + pngPath);
            return donePath;
        } catch (eSys) {
            _fixLog("全部启动方式失败 (" + tag + "): " + eSys.toString());
            return null;
        }
    }

    // 后台修复轮询表（支持同时多个合并）
    if (!$.global._syMergePolls) $.global._syMergePolls = [];
    if ($.global._syMergePollRunning !== true) $.global._syMergePollRunning = false;

    function syMergePollFn() {
        var arr = $.global._syMergePolls || [];
        var stillActive = false;
        for (var i = arr.length - 1; i >= 0; i--) {
            var s = arr[i];
            s.tries = (s.tries || 0) + 1;
            var status = "";
            var done = new File(s.donePath);
            if (done.exists) {
                try { done.open("r"); status = (done.read() || "").toString().trim(); done.close(); } catch (eR) { status = ""; }
            }
            if (status === "SYFIX:OK" || status === "SYFIX:SKIP") {
                // 磁盘已是 straight（OK=重写，SKIP=本就 straight）→ footage 也切 STRAIGHT
                var foot = app.project.itemByID(s.footageId);
                if (foot && foot.mainSource && foot.mainSource.hasAlpha) {
                    foot.mainSource.alphaMode = AlphaMode.STRAIGHT;
                    try { foot.mainSource.reload(); } catch (eR2) {}
                }
                try { done.remove(); } catch (eD) {}
                _fixLog("polled OK (" + status + ") tries=" + s.tries + " flipped STRAIGHT png=" + s.pngPath);
                arr.splice(i, 1);
            } else if (status === "SYFIX:ERR" || s.tries > 60) {
                // 工具报错或超时（约 24s）：保持合并后的预乘显示，不退化
                try { done.remove(); } catch (eD2) {}
                _fixLog("poll done/timeout (" + (status || "no-mark") + ") tries=" + s.tries + " 保持预乘 png=" + s.pngPath);
                arr.splice(i, 1);
            } else {
                stillActive = true;
            }
        }
        $.global._syMergePolls = arr;
        if (stillActive) {
            app.scheduleTask("$.global._syMergePollFn();", 400, false);
        } else {
            $.global._syMergePollRunning = false;
        }
    }
    $.global._syMergePollFn = syMergePollFn;

    // ====== 合并完成后的「透明修复」（由 Step 6 延迟触发）======
    // 合并已结束、图层已就位；这里只负责「启动」后台修复，不阻塞：
    // 启动后立刻返回（工具在 AE 外异步跑），再由 syMergePollFn 轮询完成标记，
    // 工具处理完再把 footage 切到 STRAIGHT。合并流程本身零改动、零卡顿。
    function syMergePostFix() {
        var args = $.global._syMergePostFixArgs;
        $.global._syMergePostFixArgs = null;
        _fixLog("postFix fired; argsPresent=" + (!!args));
        if (!args) return;
        var donePath = syFixLaunch(args.pngPath);
        if (!donePath) {
            _fixLog("launch failed; 保持预乘显示");
            return;
        }
        // 当前 footage 是合并导入时的 PREMULTIPLIED（AE 内看着正常）；
        // 工具把磁盘转 straight 完成后，poll 会把它切到 STRAIGHT 并 reload。
        if (!$.global._syMergePolls) $.global._syMergePolls = [];
        $.global._syMergePolls.push({
            pngPath: args.pngPath,
            footageId: args.footageId,
            donePath: donePath,
            tries: 0
        });
        if ($.global._syMergePollRunning !== true) {
            $.global._syMergePollRunning = true;
            app.scheduleTask("$.global._syMergePollFn();", 400, false);
        }
    }
    $.global._syMergePostFix = syMergePostFix;

    // ====== 修复发黑：把素材的 Alpha 解释改成「预乘 - 黑色蒙版」======
    // 场景：手动从 _raster_cache 导入的 PNG 是「预乘黑底」的，
    // 但 AE 默认按「直接/未预乘」解读 → 透明区渲染成黑色。
    // 本函数把选中素材（或选中图层的源素材）的 alphaMode 改为 PREMULTIPLIED + 黑色，
    // 等价于手动操作：解释素材 → 主要 → Alpha → 预乘 - 以颜色为蒙版（黑色）。
    function fixBlackAlpha() {
        try {
            var targets = [];

            // 优先：当前合成中选中的图层
            var comp = app.project.activeItem;
            if (comp instanceof CompItem && comp.selectedLayers.length > 0) {
                var sel = comp.selectedLayers;
                for (var i = 0; i < sel.length; i++) {
                    try { if (sel[i].source) targets.push(sel[i].source); } catch (e) {}
                }
            } else {
                // 否则：项目面板中选中的素材
                var items = app.project.selection;
                for (var j = 0; j < items.length; j++) {
                    targets.push(items[j]);
                }
            }

            if (targets.length === 0) {
                alert("[SY_Merge] \u8BF7\u5148\u9009\u4E2D\u8981\u5904\u7406\u7684\u56FE\u5C42\n"
                    + "\uFF08\u6216\u5728\u9879\u76EE\u9762\u677F\u91CC\u9009\u4E2D\u7D20\u6750\uFF09");
                return;
            }

            app.beginUndoGroup("SY Merge - \u4FEE\u590D\u53D1\u9ED1");
            var fixed = 0;
            var skipped = 0;
            for (var k = 0; k < targets.length; k++) {
                var src = targets[k];
                if (!src) continue;
                try {
                    if (src.mainSource && src.mainSource.hasAlpha) {
                        if (src.mainSource.alphaMode !== AlphaMode.PREMULTIPLIED) {
                            src.mainSource.alphaMode = AlphaMode.PREMULTIPLIED;
                            src.mainSource.premulColor = [0, 0, 0];
                            fixed++;
                        } else {
                            skipped++;   // 已经是预乘，无需重复处理
                        }
                    }
                } catch (eFix) {}
            }
            app.endUndoGroup();

            var msg = "";
            if (fixed > 0) msg += "\u5DF2\u4FEE\u590D " + fixed + " \u4E2A\u7D20\u6750";
            if (skipped > 0) msg += (msg ? "\n" : "") + skipped + " \u4E2A\u5DF2\u662F\u9884\u4E58\uFF0C\u65E0\u9700\u5904\u7406";
            if (fixed === 0 && skipped === 0) msg = "\u672A\u627E\u5230\u5E26 Alpha \u901A\u9053\u7684\u7D20\u6750";
            alert("[SY_Merge] " + msg);

        } catch (err) {
            alert("[SY_Merge] \u5904\u7406\u53D1\u9ED1\u5931\u8D25: " + err.toString());
        }
    }

    // ====== 核心：预合成 + 导出 PNG ======
    function doMerge(keepOnDisk, autoFix) {
        if (autoFix === undefined) autoFix = true;   // 默认开启自动修复
        app.beginUndoGroup("SY Merge - Export");
        try {
            var comp = app.project.activeItem;
            if (!(comp instanceof CompItem)) {
                alert("[SY_Merge] \u8BF7\u5148\u6253\u5F00\u4E00\u4E2A\u5408\u6210\u3002");
                return;
            }

            var sel = comp.selectedLayers;
            if (sel.length < 1) {
                alert("[SY_Merge] \u8BF7\u81F3\u5C11\u9009\u4E2D\u4E00\u4E2A\u56FE\u5C42\u3002");
                return;
            }

            var topIndex = sel[0].index;
            var bottomIndex = sel[0].index;
            var bottomName = sel[0].name;
            for (var s = 0; s < sel.length; s++) {
                if (sel[s].index < topIndex) topIndex = sel[s].index;
                if (sel[s].index > bottomIndex) {
                    bottomIndex = sel[s].index;
                    bottomName = sel[s].name;
                }
            }

            var frameTime = comp.time;
            var mergeName = bottomName;  // 沿用最下方图层的名字

            // 收集被选中图层中本身就是预合成的项目 ID（合并后从项目面板删除）
            var srcCompIdList = [];
            for (var sc = 0; sc < sel.length; sc++) {
                try {
                    if (sel[sc].source && sel[sc].source instanceof CompItem) {
                        srcCompIdList.push(sel[sc].source.id);
                    }
                } catch (eSrc) {}
            }
            var srcCompIds = srcCompIdList.join(",");

            // 记录 topIndex 上方图层的 ID 作为锚点（必须在 precompose 之前！）
            // precompose 后索引会变化，但图层 ID 不变，所以用 ID 定位不会错位
            var anchorLayerId = -1;
            if (topIndex > 1) {
                try { anchorLayerId = comp.layer(topIndex - 1).id; } catch (eAnch) {}
            }

            var indices = [];
            for (var i = 0; i < sel.length; i++) indices.push(sel[i].index);
            var preComp = comp.layers.precompose(indices, "Raster_src_" + mergeName, true);

            // 输出目录：工程文件旁的 _raster_cache（和工程放一起方便管理）
            // 工程未保存时 fallback 到系统临时目录
            var outFolder;
            if (app.project.file) {
                outFolder = new Folder(app.project.file.parent.fsName + "/_raster_cache");
            } else {
                outFolder = Folder.temp;
            }
            if (!outFolder.exists) outFolder.create();
            var stamp = (new Date()).getTime();

            // saveFrameToPng 是异步的：调用会立即返回，PNG 在后台慢慢写。
            // 真正的等待交给 pollAndImport（轮询 IEND 标记），这里不阻塞。
            var pngFile = new File(outFolder.fsName + "/raster_" + stamp + ".png");
            preComp.saveFrameToPng(frameTime, pngFile);
            var pngPath = pngFile.fsName;

            var compId = comp.id;
            var preCompId = preComp.id;
            var preCompName = preComp.name;

            // 将所有参数存入全局变量（避免 scheduleTask 字符串拼接时中文编码问题）
            $.global._syMergeArgs = {
                pngPath: pngPath,
                compId: compId,
                preCompId: preCompId,
                anchorLayerId: anchorLayerId,
                mergeName: mergeName,
                preCompName: preCompName,
                srcCompIds: srcCompIds,
                autoFix: autoFix,   // 是否用外部工具把磁盘 PNG 转成标准透明
                fixed: false,      // 外部工具是否成功处理（收尾时据此决定导入方式）
                tries: 0,       // 已轮询次数
                lastSize: -1,   // 上次读到的大小（兜底判定用）
                stable: 0       // 大小连续一致次数
            };

            // 50ms 后启动非阻塞轮询（pollAndImport 每 50ms 回调检查一次，
            // 期间主线程完全空闲，不依赖任何固定等待时长）
            app.scheduleTask("$.global._syMergeImport();", 50, false);

        } catch (err) {
            alert("[SY_Merge] \u51FA\u9519: " + err.toString() +
                  (err.line ? "  (line " + err.line + ")" : ""));
        } finally {
            app.endUndoGroup();
        }
    }

    // ====== 删除隐藏图层 ======
    function deleteHiddenLayers() {
        try {
            var comp = app.project.activeItem;
            if (!(comp instanceof CompItem)) {
                alert("[SY_Merge] \u8BF7\u5148\u6253\u5F00\u4E00\u4E2A\u5408\u6210\u3002");
                return;
            }
            var count = 0;
            for (var i = comp.numLayers; i >= 1; i--) {
                var lyr = comp.layer(i);
                if (lyr.shy && !lyr.enabled) {
                    lyr.remove();
                    count++;
                }
            }
            if (count === 0) {
                alert("[SY_Merge] \u5F53\u524D\u5408\u6210\u6CA1\u6709\u9690\u85CF\u7684\u5408\u5E76\u6E90\u56FE\u5C42\u3002");
            }
        } catch (err) {
            alert("[SY_Merge] \u5220\u9664\u9690\u85CF\u56FE\u5C42\u51FA\u9519: " + err.toString());
        }
    }

    // 合并选项（供快捷键读取，保证 Ctrl+Tab 快捷键也遵守面板里的勾选状态）
    $.global._syMergeOpts = $.global._syMergeOpts || { keepOnDisk: true, autoFix: false };

    // 注册全局函数，供快捷键触发脚本和面板按钮调用
    // 注意：必须用 $.global._syMergeOpts 读取勾选状态，不能硬编码 true——
    // 这里在 buildUI 作用域之外，访问不到面板里的复选框变量。
    $.global._doMergeLayers = function () {
        var o = $.global._syMergeOpts || {};
        doMerge(o.keepOnDisk !== false, o.autoFix !== false);
    };

    // ====== 启动 ======
    autoInstallRunner();   // 自动在 Scripts 目录写入/更新触发脚本

    // ====== 构建 UI ======
    function buildUI(container) {
        var pal = (container instanceof Panel)
            ? container
            : new Window("palette", "SY_Merge", undefined, { resizeable: true });

        pal.orientation = "column";
        pal.alignChildren = ["fill", "top"];
        pal.spacing = 8;
        pal.margins = [12, 12, 12, 12];

        // 分割线
        var sep1 = pal.add("panel");
        sep1.preferredSize.height = 2;
        sep1.alignment = ["fill", "top"];

        // 合并按钮
        var btnMerge = pal.add("button", undefined, "\u5408\u5E76");
        btnMerge.alignment = ["left", "center"];
        btnMerge.helpTip = "\u5C06\u9009\u4E2D\u56FE\u5C42\u5408\u5E76\u4E3A\u4E00\u5F20 PNG \u5355\u5C42 (Ctrl+Tab)";

        var btnFixBlack = pal.add("button", undefined, "\u5904\u7406\u53D1\u9ED1");
        btnFixBlack.alignment = ["left", "center"];
        btnFixBlack.helpTip = "\u5C06\u9009\u4E2D\u7D20\u6750\u7684 Alpha \u6539\u4E3A\u300C\u9884\u4E58 - \u9ED1\u8272\u8499\u7248\u300D\uFF0C\u4FEE\u590D\u900F\u660E\u533A\u53D1\u9ED1";

        var btnDelHidden = pal.add("button", undefined, "\u5220\u9664\u9690\u85CF");
        btnDelHidden.alignment = ["left", "center"];
        btnDelHidden.helpTip = "\u5220\u9664\u5F53\u524D\u5408\u6210\u4E2D\u5408\u5E76\u540E\u4FDD\u7559\u7684\u9690\u85CF\u6E90\u56FE\u5C42";

        // 选项区
        var optGrp = pal.add("group");
        optGrp.orientation = "column";
        optGrp.alignChildren = ["left", "center"];
        optGrp.spacing = 4;
        var chkKeep = optGrp.add("checkbox", undefined,
            "PNG \u4FDD\u5B58\u5230\u5DE5\u7A0B\u65C1 (_raster_cache)");
        chkKeep.value = true;
        var chkAutoFix = optGrp.add("checkbox", undefined,
            "\u5408\u5E76\u540E\u4FEE\u590D\u9ED1\u5E95\uFF08\u5916\u90E8\u5DE5\u5177\u8F6C\u6807\u51C6\u900F\u660E\uFF09");
        chkAutoFix.value = false;

        // 把勾选状态同步到全局对象，让 Ctrl+Tab 快捷键（_doMergeLayers）也能遵守
        function _syncOpts() {
            if (!$.global._syMergeOpts) $.global._syMergeOpts = {};
            $.global._syMergeOpts.keepOnDisk = chkKeep.value;
            $.global._syMergeOpts.autoFix = chkAutoFix.value;
        }
        _syncOpts();
        chkKeep.onClick = _syncOpts;
        chkAutoFix.onClick = _syncOpts;

        // 分割线
        var sep2 = pal.add("panel");
        sep2.preferredSize.height = 2;
        sep2.alignment = ["fill", "top"];

        // 使用提示（小字号）
        var smallFont = ScriptUI.newFont("dialog", "Regular", 9);

        var tipGrp = pal.add("group");
        tipGrp.orientation = "column";
        tipGrp.alignChildren = ["fill", "top"];
        tipGrp.spacing = 2;

        var tipTitle = tipGrp.add("statictext", undefined, "\u4F7F\u7528\u65B9\u6CD5");
        tipTitle.graphics.font = ScriptUI.newFont("dialog", "Bold", 10);

        var tip1 = tipGrp.add("statictext", undefined, "1. \u9009\u4E2D\u8981\u5408\u5E76\u7684\u56FE\u5C42");
        tip1.graphics.font = smallFont;
        var tip2 = tipGrp.add("statictext", undefined, "2. \u70B9\u51FB\u300C\u5408\u5E76\u300D\u6309\u94AE\u6216\u6309 Ctrl+Tab");
        tip2.graphics.font = smallFont;
        var tip3 = tipGrp.add("statictext", undefined, "3. \u539F\u56FE\u5C42\u81EA\u52A8\u9690\u85CF\u4FDD\u7559\uFF0C\u53EF\u968F\u65F6\u6062\u590D");
        tip3.graphics.font = smallFont;
        var tip4 = tipGrp.add("statictext", undefined, "4. \u70B9\u300C\u5220\u9664\u9690\u85CF\u300D\u6E05\u7406\u5408\u5E76\u6E90\u56FE\u5C42");
        tip4.graphics.font = smallFont;

        // 分割线
        var sep3 = pal.add("panel");
        sep3.preferredSize.height = 2;
        sep3.alignment = ["fill", "top"];

        // 快捷键提示（小字号）
        var hotkeyGrp = pal.add("group");
        hotkeyGrp.orientation = "column";
        hotkeyGrp.alignChildren = ["fill", "top"];
        hotkeyGrp.spacing = 2;

        var hkTitle = hotkeyGrp.add("statictext", undefined, "\u5FEB\u6377\u952E\u8BBE\u7F6E");
        hkTitle.graphics.font = ScriptUI.newFont("dialog", "Bold", 10);

        var hkTip1 = hotkeyGrp.add("statictext", undefined,
            "\u7F16\u8F91 > \u952E\u76D8\u5FEB\u6377\u65B9\u5F0F > \u641C\u7D22 SY_Merge_Run");
        hkTip1.graphics.font = smallFont;
        var hkTip2 = hotkeyGrp.add("statictext", undefined,
            "\u7ED1\u5B9A Ctrl+Tab \u5373\u53EF\u5168\u5C40\u5FEB\u6377\u5408\u5E76");
        hkTip2.graphics.font = smallFont;

        // 按钮事件
        btnMerge.onClick = function () {
            doMerge(chkKeep.value, chkAutoFix.value);
        };

        btnFixBlack.onClick = function () {
            fixBlackAlpha();
        };

        btnDelHidden.onClick = function () {
            deleteHiddenLayers();
        };

        pal.layout.layout(true);
        return pal;
    }

    var myPanel = buildUI(thisObj);
    if (myPanel instanceof Window) {
        myPanel.center();
        myPanel.show();
    }

})(this);

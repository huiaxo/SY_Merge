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

            // ---- Step 3: 设置 footage 属性 ----
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

        } catch (err) {
            alert("[SY_Merge] \u5BFC\u56DE\u51FA\u9519: " + err.toString() +
                  (err.line ? "  (line " + err.line + ")" : ""));
        } finally {
            app.endUndoGroup();
            $.global._syMergeArgs = null;
        }
    }

    $.global._syMergeImport = pollAndImport;

    // ====== 核心：预合成 + 导出 PNG ======
    function doMerge(keepOnDisk) {
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
            var pngPath = outFolder.fsName + "/raster_" + stamp + ".png";
            var pngFile = new File(pngPath);

            preComp.saveFrameToPng(frameTime, pngFile);

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

    // 注册全局函数，供快捷键触发脚本和面板按钮调用
    $.global._doMergeLayers = function () { doMerge(true); };

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

        // 标题
        var titleGrp = pal.add("group");
        titleGrp.alignment = ["fill", "top"];
        titleGrp.alignChildren = ["center", "center"];
        var titleTxt = titleGrp.add("statictext", undefined, "SY Merge");
        titleTxt.graphics.font = ScriptUI.newFont("dialog", "Bold", 14);

        // 分割线
        var sep1 = pal.add("panel");
        sep1.preferredSize.height = 2;
        sep1.alignment = ["fill", "top"];

        // 合并按钮
        var btnMerge = pal.add("button", undefined, "\u5408\u5E76");
        btnMerge.preferredSize.height = 36;
        btnMerge.helpTip = "\u5C06\u9009\u4E2D\u56FE\u5C42\u5408\u5E76\u4E3A\u4E00\u5F20 PNG \u5355\u5C42 (Ctrl+Tab)";

        var btnDelHidden = pal.add("button", undefined, "\u5220\u9664\u9690\u85CF");
        btnDelHidden.preferredSize.height = 30;
        btnDelHidden.helpTip = "\u5220\u9664\u5F53\u524D\u5408\u6210\u4E2D\u5408\u5E76\u540E\u4FDD\u7559\u7684\u9690\u85CF\u6E90\u56FE\u5C42";

        // 选项区
        var optGrp = pal.add("group");
        optGrp.orientation = "row";
        optGrp.alignChildren = ["left", "center"];
        optGrp.spacing = 4;
        var chkKeep = optGrp.add("checkbox", undefined,
            "PNG \u4FDD\u5B58\u5230\u5DE5\u7A0B\u65C1 (_raster_cache)");
        chkKeep.value = true;

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
            doMerge(chkKeep.value);
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

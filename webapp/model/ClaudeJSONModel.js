// ClaudeJSONModel.js
sap.ui.define([
    "sap/ui/model/json/JSONModel",
    "sap/m/Dialog",
    "sap/m/Button",
    "sap/m/FormattedText",
    "sap/m/HBox",
    "sap/m/IconTabBar",
    "sap/m/IconTabFilter",
    "sap/m/VBox",
    "sap/m/TextArea",
    "sap/m/Title",
    "sap/m/Label",
    "sap/m/Toolbar",
    "sap/m/ToolbarSpacer",
    "sap/ui/core/HTML",
    "sap/m/SegmentedButton",
    "sap/m/SegmentedButtonItem",
    "sap/ui/core/EventBus"
// eslint-disable-next-line max-params
], function (JSONModel, Dialog, Button, FormattedText, HBox, IconTabBar, IconTabFilter, VBox, TextArea, Title, Label, Toolbar, ToolbarSpacer, HTML, SegmentedButton, SegmentedButtonItem, EventBus) {
    "use strict";
    /* global Promise */

    let _markedPromise = null;
    const INSPECTOR_KEY = "__prompt__";

    /**
     * JSONModel extension for structured Claude API calls.
     * One instance can handle multiple independent calls — each identified by an id.
     *
     * Constructor:
     *   const oModel = new ClaudeJSONModel({
     *       maxTokens: 1500,
     *       language: "de",
     *       directBrowserAccess: true,
     *       data: {                   // seeds the JSONModel root for view bindings
     *           filter: { topic: "SAP", range: "7d" },
     *           generateEnabled: false
     *       }
     *   });
     *
     * setPrompt:
     *   oModel.setPrompt("useCases", sPrompt, { schema: oSchema });         // → json
     *   oModel.setPrompt("summary",  sPrompt);                              // → text
     *   oModel.setPrompt("report",   sPrompt, { responseType: "markdown" }); // → markdown
     *   // Data at   /useCases/data
     *   // State at  /useCases/state  ("loading" | "results" | "error")
     *   // Error at  /useCases/error
     */
    const ClaudeJSONModel = JSONModel.extend("de.udina.model.ClaudeJSONModel", {

        /**
         * @param {object} [mConfig]
         * @param {object} [mConfig.data]               - Initial model data merged into the JSONModel root.
         *   Use this to seed properties consumed by view bindings before any Claude call is made,
         *   e.g. filter values, selection state, or default display values.
         *   Example: { filters: { category: "All" }, selectedId: null }
         * @param {number} [mConfig.maxTokens=1024]      - Claude max_tokens per request
         * @param {boolean} [mConfig.directBrowserAccess=false] - Add browser-access header (CORS bypass for direct API calls)
         * @param {string} [mConfig.apiEndpoint]         - Override API URL (default: Anthropic v1/messages)
         * @param {string} [mConfig.language]            - BCP-47 locale for response language (default: UI5 locale)
         */
        constructor: function (mConfig) {
            JSONModel.call(this, mConfig?.data || {});

            this._oDelegates = [];
            this._sModel = "claude-sonnet-4-6";
            this._mConfig = Object.assign({
                maxTokens: 1024,
                directBrowserAccess: false,
                apiEndpoint: undefined,
                language: undefined,
                mcpServers: undefined
            }, mConfig);

            this._sApiUrl = this._mConfig.apiEndpoint || "/v1/messages";
            this._oDialogs = {};
            this._oLastPrompts = {};
        },

        destroy: function () {
            // cleanup all delegates
            this._oDelegates.forEach(function (oEntry) {
                oEntry.control.removeEventDelegate(oEntry.delegate);
            });
            this._oDelegates = [];

            // Parent destroy aufrufen
            JSONModel.prototype.destroy.apply(this, arguments);
        },

        /**
         * Trigger a Claude call and store results under /{sId}.
         * @param {string} sId       - Namespace key (e.g. "useCases", "deepDive")
         * @param {string} sTemplate - Prompt text; may contain {{name}} or {{0}} placeholders
         * @param {object} [oOptions]
         * @param {Object} [oOptions.params]               - Named values for {param>key} placeholders in the template
         * @param {Object} [oOptions.maps]                 - Named lookup maps for {MAP_NAME>/path|fallback} placeholders
         * @param {Array|Object} [oOptions.outputExample]  - Example of the expected JSON output → implies responseType "json"
         * @param {object}       [oOptions.constraints]    - Field-level constraints rendered into the system prompt, e.g. { impact: { type: "integer", min: 10, max: 99 } }
         * @param {string} [oOptions.responseType]         - "json"|"markdown"|"text"; auto: outputExample→"json", else "text"
         * @param {function} [oOptions.mapper]           - (item, index) => item; applied to each array element after parse
         * @param {string} [oOptions.language]           - BCP-47 locale override for this call only, e.g. "en" on a "de" model
         * @param {string} [oOptions.image]              - Base64 image as data URL (e.g. from canvas.toDataURL()), sent as vision input alongside the prompt
         */
        // eslint-disable-next-line complexity, max-statements
        setPrompt: async function (sId, sTemplate, oOptions) {
            const sBase = "/" + sId.replace(/^\//, "");
            const sPrompt = this._dedent(
                (oOptions && (oOptions.params || oOptions.maps))
                    ? this._resolveTemplate(sTemplate, oOptions)
                    : this._resolveTemplate(sTemplate, {}));
            const oOutputExample = oOptions && oOptions.outputExample;
            const oConstraints = oOptions && oOptions.constraints;
            const sType = (oOptions && oOptions.responseType) || (oOutputExample ? "json" : "text");
            const sImageDataUrl = oOptions && oOptions.image;

            if (!this.getProperty(sBase)) {
                this.setProperty(sBase, {});
            }
            this.setProperty(sBase + "/state", "loading");
            this.setProperty(sBase + "/error", null);
            this.setProperty(sBase + "/data", null);

            const sSystemPrompt = this._buildSystemPrompt(sType, oOutputExample, oConstraints, oOptions && oOptions.language);
            // eslint-disable-next-line @sap-ux/fiori-tools/sap-no-ui5base-prop
            this._oLastPrompts[sId] = { system: sSystemPrompt, user: sImageDataUrl ? "[Image]\n" + sPrompt : sPrompt, type: sType };

            const fnUpdateInspector = (sText, bBusy, oResponse) => {
                const oInsp = this._oDialogs[INSPECTOR_KEY];
                if (!oInsp || !oInsp.dialog.isOpen()) { return; }
                const oTab = this._addInspectorTab(sId, oInsp);
                if (bBusy) {
                    oTab.parsedValue = "";
                    oTab.rawValue = "";
                    oTab.segBtn.setSelectedKey("parsed");
                    oTab.resultArea.setValue("");
                    oTab.resultArea.setBusy(true);
                } else {
                    let sDisplay = sText || "";
                    try { sDisplay = JSON.stringify(JSON.parse(sText), null, 2); } catch { /* not JSON */ }
                    oTab.parsedValue = sDisplay;
                    oTab.rawValue = oResponse ? JSON.stringify(oResponse, null, 2) : "";
                    oTab.resultArea.setValue(oTab.segBtn.getSelectedKey() === "raw" ? oTab.rawValue : oTab.parsedValue);
                    oTab.resultArea.setBusy(false);
                    if (oInsp.usageLabel && oInsp.tabBar.getSelectedKey() === sId) {
                        oInsp.usageLabel.setText(oResponse?.usage ? this._formatUsage(oResponse.usage) : "");
                    }
                }
            };
            fnUpdateInspector("", true);

            const aMcpServers = this._mConfig.mcpServers;

            const vUserContent = sImageDataUrl
                ? [
                    {
                        type: "image",
                        source: Object.assign({ type: "base64" }, this._parseDataUrl(sImageDataUrl))
                    },
                    { type: "text", text: sPrompt }
                ]
                : sPrompt;

            try {
                const oResponse = await fetch(this._sApiUrl, {
                    method: "POST",
                    headers: Object.assign(
                        {
                            "Content-Type": "application/json",
                            "anthropic-version": "2023-06-01"
                        },
                        aMcpServers && { "anthropic-beta": "mcp-client-2025-11-20" }
                    ),
                    body: JSON.stringify(Object.assign(
                        {
                            model: this._sModel,
                            // eslint-disable-next-line camelcase
                            max_tokens: this._mConfig.maxTokens,
                            system: sSystemPrompt,
                            messages: [{ role: "user", content: vUserContent }]
                        },
                        aMcpServers && {
                            // eslint-disable-next-line camelcase
                            mcp_servers: aMcpServers,
                            // eslint-disable-next-line camelcase
                            tools: aMcpServers.map(s => ({ type: "mcp_toolset", mcp_server_name: s.name }))
                        }
                    ))
                }).then(r => r.json());

                if (oResponse?.type === "error") {
                    throw new Error(oResponse.error?.message ?? "API error");
                }
                const sText = oResponse?.content?.findLast(c => c.type === "text")?.text ?? "";
                const oParsed = this._parse(sText, sType);
                const oProcessed = sType === "markdown" ? await this._mdToHtml(oParsed) : oParsed;
                const fnMapper = oOptions && oOptions.mapper;
                let oData = oProcessed;
                if (fnMapper) {
                    oData = Array.isArray(oProcessed) ? oProcessed.map(fnMapper) : fnMapper(oProcessed);
                }
                // eslint-disable-next-line @sap-ux/fiori-tools/sap-no-ui5base-prop
                this._oLastPrompts[sId].result = sText;
                // eslint-disable-next-line @sap-ux/fiori-tools/sap-no-ui5base-prop
                this._oLastPrompts[sId].rawResponse = oResponse;
                // eslint-disable-next-line @sap-ux/fiori-tools/sap-no-ui5base-prop
                this._oLastPrompts[sId].usage = oResponse?.usage;
                if (oResponse?.usage) {
                    EventBus.getInstance().publish("claude.model", "usageCost", {
                        usage: oResponse.usage,
                        model: this._sModel,
                        id: sId
                    });
                }
                fnUpdateInspector(sText, false, oResponse);
                this.setProperty(sBase + "/data", oData);
                this.setProperty(sBase + "/state", "results");
                return oData;
            } catch (oErr) {
                // eslint-disable-next-line no-console
                console.error("ClaudeJSONModel fetch error:", oErr);
                fnUpdateInspector(oErr.message, false);
                this.setProperty(sBase + "/error", oErr.message);
                this.setProperty(sBase + "/state", "error");
                throw oErr;
            }
        },

        /**
         * @param {string|string[]} vPath      - Model path or array of paths to watch
         * @param {function}        fnCallback - Called whenever any watched path changes
         *   Single path:  fnCallback(newValue, oldValue)
         *   Array of paths: fnCallback([newA, newB], [oldA, oldB])
         *
         * @example
         * // Single path – fires on every state change
         * model.watch("/briefing/state", (newVal, oldVal) => {
         *     console.log("state:", oldVal, "→", newVal);
         * });
         *
         * @example
         * // Multiple paths – fires when either changes, receives both new and old values
         * model.watch(["/briefing/state", "/filter/focusSelect"],
         *     ([newState, newFocus], [oldState, oldFocus]) => {
         *         if (newState === "results") doSomething(newFocus);
         *     }
         * );
         */
        watch: function (vPath, fnCallback) {
            const bMulti = Array.isArray(vPath);
            const aPaths = bMulti ? vPath : [vPath];
            const aCurrent = aPaths.map(s => this.getProperty(s));

            this.attachPropertyChange(oEvent => {
                if (!aPaths.includes(oEvent.getParameter("path"))) { return; }
                const aOld = aCurrent.slice();
                aPaths.forEach((s, i) => { aCurrent[i] = this.getProperty(s); });
                if (bMulti) {
                    fnCallback(aCurrent.slice(), aOld);
                } else {
                    fnCallback(aCurrent[0], aOld[0]);
                }
            });
        },

        /**
         * Opens a dialog showing the last built system and user prompt for the given sId.
         * @param {string} sId    - Same id as used in setPrompt
         * @param {object} oOwner - UI5 control to addDependent on (e.g. the view)
         */
        openPromptDialog: function (sId, oOwner) {
            // eslint-disable-next-line @sap-ux/fiori-tools/sap-no-ui5base-prop
            const oLast = this._oLastPrompts[sId];
            if (!oLast) { return; }

            if (!this._oDialogs[INSPECTOR_KEY]) {
                const sModelInfo = this._sModel + "  ·  max " + this._mConfig.maxTokens + " tokens";
                const oUsageLabel = new Label({ text: "" });
                const oTabBar = new IconTabBar({ expandable: false, stretchContentHeight: true });
                const oTabs = {};
                const oSegBtn = new SegmentedButton({
                    selectedKey: "parsed",
                    items: [
                        new SegmentedButtonItem({ key: "parsed", icon: "sap-icon://syntax", text: "Parsed" }),
                        new SegmentedButtonItem({ key: "raw", icon: "sap-icon://source-code", text: "Response" })
                    ],
                    selectionChange: function () {
                        const oActiveTab = oTabs[oTabBar.getSelectedKey()];
                        if (!oActiveTab) { return; }
                        const sKey = oSegBtn.getSelectedKey();
                        oActiveTab.resultArea.setValue(sKey === "raw" ? (oActiveTab.rawValue || "") : (oActiveTab.parsedValue || ""));
                        oActiveTab.resultLabel.setText(sKey === "raw" ? "Response  ·  JSON" : "Result  ·  " + (oActiveTab.type || ""));
                    }
                });

                const oDialog = new Dialog({
                    title: "Prompt Inspector",
                    draggable: true,
                    resizable: true,
                    contentWidth: "70vw",
                    contentHeight: "70vh",
                    horizontalScrolling: false,
                    verticalScrolling: false,
                    customHeader: new Toolbar({
                        content: [
                            new Title({ text: "Prompt Inspector" }),
                            new ToolbarSpacer(),
                            oSegBtn
                        ]
                    }),
                    footer: new Toolbar({
                        content: [
                            new Label({ text: sModelInfo }),
                            new ToolbarSpacer(),
                            oUsageLabel,
                            new ToolbarSpacer(),
                            new Button({
                                text: "{i18n>Close}",
                                type: "Emphasized",
                                press: function () { oDialog.close(); }
                            })
                        ]
                    }),
                    content: [oTabBar]
                });

                if (oOwner) { oOwner.addDependent(oDialog); }
                this._oDialogs[INSPECTOR_KEY] = { dialog: oDialog, tabBar: oTabBar, tabs: oTabs, segBtn: oSegBtn, usageLabel: oUsageLabel };

                oTabBar.attachSelect(oEvent => {
                    const sKey = oEvent.getParameter("selectedKey");
                    const oRef = this._oLastPrompts[sKey];
                    oUsageLabel.setText(oRef?.usage ? this._formatUsage(oRef.usage) : "");
                });
            }

            const oInspector = this._oDialogs[INSPECTOR_KEY];

            // Ensure a tab exists for every known prompt and populate all values
            Object.keys(this._oLastPrompts).forEach(sPid => {
                const oTabRef = this._addInspectorTab(sPid, oInspector);
                const oLastRef = this._oLastPrompts[sPid];
                oTabRef.systemArea.setValue(oLastRef.system);
                oTabRef.userArea.setValue(oLastRef.user);
                oTabRef.type = (oLastRef.type || "text").toUpperCase();
                oTabRef.resultLabel.setText(oTabRef.segBtn.getSelectedKey() === "raw" ? "Response  ·  JSON" : "Result  ·  " + oTabRef.type);
                if (oLastRef.result === undefined) {
                    oTabRef.parsedValue = "";
                    oTabRef.rawValue = "";
                    oTabRef.segBtn.setSelectedKey("parsed");
                    oTabRef.resultArea.setValue("");
                    oTabRef.resultArea.setBusy(true);
                } else {
                    let sResult = oLastRef.result || "";
                    try { sResult = JSON.stringify(JSON.parse(sResult), null, 2); } catch { /* not JSON */ }
                    oTabRef.parsedValue = sResult;
                    oTabRef.rawValue = oLastRef.rawResponse ? JSON.stringify(oLastRef.rawResponse, null, 2) : "";
                    oTabRef.resultArea.setValue(oTabRef.segBtn.getSelectedKey() === "raw" ? oTabRef.rawValue : oTabRef.parsedValue);
                    oTabRef.resultArea.setBusy(false);
                }
            });
            oInspector.tabBar.setSelectedKey(sId);
            // eslint-disable-next-line @sap-ux/fiori-tools/sap-no-ui5base-prop
            const oCurrentRef = this._oLastPrompts[sId];
            oInspector.usageLabel.setText(oCurrentRef?.usage ? this._formatUsage(oCurrentRef.usage) : "");
            oInspector.dialog.open();
        },

        /**
         * Opens a dialog with static or async content.
         * When content is a Promise, the dialog opens immediately in busy state and populates on resolve.
         * @param {object} mConfig
         * @param {string|Promise} mConfig.content     - Static string or Promise resolving to the result
         * @param {string} mConfig.title               - Dialog title
         * @param {string} [mConfig.contentType]       - "text" | "formattedText" | "markdown" | "html" (iframe); default "text"
         * @param {string} [mConfig.id]                - Key for dialog reuse in Promise path (default "__result__")
         * @param {object} [mConfig.owner]             - UI5 control to addDependent on (e.g. the view)
         * @param {string} [mConfig.contentWidth]      - Dialog width (default "50rem")
         * @param {string} [mConfig.contentHeight]     - Dialog/iframe height (default for "html": "70vh")
         */
        showDialog: function (mConfig) {
            if (typeof mConfig.content?.then === "function") {
                const oCtrl = this._getOrCreateDialog(mConfig.id || "__result__", mConfig);
                oCtrl.dialog.setTitle(mConfig.title || "");
                oCtrl.text.setHtmlText("");
                oCtrl.dialog.setBusy(true);
                oCtrl.dialog.open();
                mConfig.content.then(async oData => {
                    let sHtml;
                    if (typeof oData !== "string") {
                        sHtml = "<pre>" + JSON.stringify(oData, null, 2) + "</pre>";
                    } else if (mConfig.contentType === "markdown") {
                        sHtml = await this._mdToHtml(oData);
                    } else {
                        sHtml = oData;
                    }
                    oCtrl.text.setHtmlText(sHtml);
                    oCtrl.dialog.setBusy(false);
                }).catch(oErr => {
                    oCtrl.text.setHtmlText("<p>" + oErr.message + "</p>");
                    oCtrl.dialog.setBusy(false);
                });
                return;
            }
            const SHOW_KEY = "__show__";
            if (!this._oDialogs[SHOW_KEY]) {
                const oContainer = new VBox({ renderType: "Bare" });
                const oDialog = new Dialog({
                    //stretch: true,
                    draggable: true,
                    resizable: true,
                    horizontalScrolling: false,
                    endButton: new Button({
                        text: "Close",
                        type: "Emphasized",
                        press: function () { oDialog.close(); }
                    }),
                    content: [oContainer]
                });
                this._oDialogs[SHOW_KEY] = { dialog: oDialog, container: oContainer };
            }

            const oCtrl = this._oDialogs[SHOW_KEY];
            const oDialog = oCtrl.dialog;

            if (mConfig.owner && !oCtrl.ownerSet) {
                mConfig.owner.addDependent(oDialog);
                oCtrl.ownerSet = true;
            }

            oDialog.setTitle(mConfig.title || "");
            oDialog.setContentWidth(mConfig.contentWidth || "50rem");
            oCtrl.container.destroyItems();

            const sType = mConfig.contentType || "text";

            if (sType === "html") {
                const sHeight = mConfig.contentHeight || "70vh";
                oDialog.setContentHeight(sHeight);
                oCtrl.container.setHeight("100vh");
                let sSrc = mConfig.content;
                // eslint-disable-next-line @sap-ux/fiori-tools/sap-no-localhost
                if (/^https?:\/\//.test(sSrc) && window.location.hostname === "localhost") {
                    sSrc = "/proxy?url=" + encodeURIComponent(sSrc);
                }
                oCtrl.container.addItem(new HTML({
                    content: `<iframe src="${sSrc}" style="width:100%;height:100%;border:none;display:block;"/>`
                }));
            } else {
                oDialog.setContentHeight(mConfig.contentHeight || "");
                oCtrl.container.setHeight("");
                if (sType === "markdown") {
                    oDialog.setBusy(true);
                    oDialog.setBusyIndicatorDelay(0);
                    this._mdToHtml(mConfig.content).then(sHtml => {
                        oCtrl.container.addItem(
                            new FormattedText({ htmlText: sHtml }).addStyleClass("sapUiMediumMargin")
                        );
                        oDialog.setBusy(false);
                    });
                } else {
                    const sHtml = sType === "text"
                        ? mConfig.content.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br>")
                        : mConfig.content;
                    oCtrl.container.addItem(
                        new FormattedText({ htmlText: sHtml }).addStyleClass("sapUiMediumMargin")
                    );
                }
            }

            oDialog.open();
        },

        _getOrCreateDialog: function (sId, mCfg) {
            // eslint-disable-next-line @sap-ux/fiori-tools/sap-no-ui5base-prop
            if (!this._oDialogs[sId]) {
                const oText = new FormattedText().addStyleClass("sapUiMediumMargin");
                /*
                this._attachStyleDelegate(oText,
                    "background-color: var(--sapGroup_ContentBackground);"
                );
                */

                const oDialog = new Dialog({
                    busy: true,
                    busyIndicatorDelay: 0,
                    draggable: true,
                    resizable: true,
                    contentWidth: mCfg.contentWidth || "40rem",
                    endButton: new Button({
                        text: "{i18n>Close}",
                        type: "Emphasized",
                        press: function () { oDialog.close(); }
                    }),
                    content: [new VBox({ renderType: "Bare", items: [oText] })]
                });
                if (mCfg.owner) {
                    mCfg.owner.addDependent(oDialog);
                }
                // eslint-disable-next-line @sap-ux/fiori-tools/sap-no-ui5base-prop
                this._oDialogs[sId] = { dialog: oDialog, text: oText };
            }
            // eslint-disable-next-line @sap-ux/fiori-tools/sap-no-ui5base-prop
            return this._oDialogs[sId];
        },

        _calcCost: function (oUsage) {
            return ClaudeJSONModel.calcCost(oUsage, this._sModel);
        },

        _formatUsage: function (oUsage) {
            if (!oUsage) { return ""; }
            const nMax = this._mConfig.maxTokens;
            const nCost = this._calcCost(oUsage);
            const sCost = nCost > 0
                ? "  ·  ~$" + (nCost < 0.00001 ? nCost.toExponential(2) : nCost.toFixed(5))
                : "";
            return "in: " + oUsage.input_tokens + "  ·  out: " + oUsage.output_tokens + " / " + nMax + sCost;
        },

        _addInspectorTab: function (sId, oInspector) {
            // eslint-disable-next-line @sap-ux/fiori-tools/sap-no-ui5base-prop
            if (oInspector.tabs[sId]) { return oInspector.tabs[sId]; }
            const oSystemArea = new TextArea({ editable: false, height: "100%" });
            const oUserArea = new TextArea({ editable: false, height: "100%" });
            const oResultArea = new TextArea({ editable: false, height: "100%", busyIndicatorDelay: 0 });
            const oResultLabel = new Label({ text: "Result", design: "Bold" });

            let oTab = null;

            oInspector.tabBar.addItem(new IconTabFilter({
                key: sId,
                text: sId,
                content: [
                    new HBox({
                        renderType: "Bare",
                        height: "100%",
                        items: [
                            new VBox({
                                renderType: "Bare",
                                width: "33%",
                                items: [
                                    new Label({ text: "System Prompt", design: "Bold" }),
                                    oSystemArea
                                ]
                            }).addStyleClass("sapUiTinyMarginEnd"),
                            new VBox({
                                renderType: "Bare",
                                width: "33%",
                                items: [
                                    new Label({ text: "User Prompt", design: "Bold" }),
                                    oUserArea
                                ]
                            }).addStyleClass("sapUiTinyMarginEnd"),
                            new VBox({
                                renderType: "Bare",
                                width: "34%",
                                items: [
                                    oResultLabel,
                                    oResultArea
                                ]
                            })
                        ]
                    })
                ]
            }));
            oTab = { systemArea: oSystemArea, userArea: oUserArea, resultArea: oResultArea, resultLabel: oResultLabel, segBtn: oInspector.segBtn, parsedValue: null, rawValue: null, type: null };
            // eslint-disable-next-line @sap-ux/fiori-tools/sap-no-ui5base-prop
            oInspector.tabs[sId] = oTab;
            return oTab;
        },

        _getUi5Language: function () {
            if (this._mConfig.language) {
                return this._mConfig.language;
            }
            try {
                // UI5 ≥ 1.120 exposes a static Configuration object
                if (sap.ui.core?.Configuration?.getLanguage) {
                    return sap.ui.core.Configuration.getLanguage();
                }
                return sap.ui.getCore().getConfiguration().getLanguage();
            } catch {
                return null;
            }
        },

        _buildConstraintsText: function (oConstraints) {
            const aLines = Object.entries(oConstraints).map(function ([sField, mRule]) {
                const aParts = [];
                if (mRule.type) { aParts.push(mRule.type); }
                if (mRule.min !== undefined && mRule.max !== undefined) { aParts.push(mRule.min + "–" + mRule.max); }
                else if (mRule.min !== undefined) { aParts.push("min " + mRule.min); }
                else if (mRule.max !== undefined) { aParts.push("max " + mRule.max); }
                return "- " + sField + ": " + aParts.join(", ");
            });
            return "Field constraints:\n" + aLines.join("\n");
        },

        _calcMaxWords: function (nMaxTokens, sLocale) {
            const sLang = sLocale ? sLocale.split(/[-_]/)[0].toLowerCase() : "en";
            const mRatios = { de: 0.65, en: 0.75, fr: 0.70, es: 0.68, pl: 0.60 };
            const nRatio = mRatios[sLang] || 0.70;
            return Math.floor(nMaxTokens * nRatio * 0.85);
        },

        _buildSystemPrompt: function (sType, oOutputExample, oConstraints, sLanguageOverride) {
            const sLocale = sLanguageOverride || this._getUi5Language();
            const sLangInstruction = sLocale
                ? `\nRespond in the language matching locale "${sLocale}".`
                : "";
            const nMaxWords = this._calcMaxWords(this._mConfig.maxTokens, sLocale);
            const sWordLimit = `\nMaximum ${nMaxWords} words. If content would exceed this, summarize or prioritize the most important parts.`;

            switch (sType) {
                case "json": {
                    let sPrompt = "Reply ONLY with valid JSON. No Markdown, no explanations." +
                        " Use compact JSON without whitespace or indentation." +
                        " If returning multiple items, wrap them in a JSON array." + sLangInstruction;
                    if (oOutputExample) { sPrompt += `\nStructure:\n${JSON.stringify(oOutputExample)}`; }
                    if (oConstraints) { sPrompt += `\n${this._buildConstraintsText(oConstraints)}`; }
                    return sPrompt;
                }

                case "markdown":
                    return `Reply with well-structured Markdown. Use headings, lists, and code blocks where appropriate.${sLangInstruction}${sWordLimit}`;

                case "text":
                default:
                    return `Reply in clear, concise plain text without any formatting.${sLangInstruction}${sWordLimit}`;
            }
        },

        _parse: function (sRaw, sType) {
            switch (sType) {
                case "json": {
                    const sClean = sRaw.replace(/```json|```/g, "").trim();
                    const nStart = sClean.search(/[{[]/);
                    const nEnd = Math.max(sClean.lastIndexOf("}"), sClean.lastIndexOf("]"));
                    const sJson = nStart >= 0 && nEnd > nStart ? sClean.slice(nStart, nEnd + 1) : sClean;
                    try {
                        return JSON.parse(sJson);
                    } catch {
                        // Claude returned NDJSON (multiple objects) — wrap in array
                        return JSON.parse("[" + sJson.replace(/\}\s*\{/g, "},{") + "]");
                    }
                }
                case "markdown":
                case "text":
                default:
                    return sRaw;
            }
        },

        /**
         * Returns the stored image data URL for the given id, or null if not set.
         * @param {string} sId - Namespace key (e.g. "vision")
         * @returns {string|null}
         */
        getImage: function (sId) {
            return this.getProperty("/" + sId.replace(/^\//, "") + "/image") || null;
        },

        /**
         * Reads an image file from a FileUploader event, resizes it via canvas, and stores
         * the resulting base64 data URL at /{sId}/image. Resets /{sId}/state to "idle"
         * so the UI does not show stale results from a previous call.
         * @param {string} sId - Namespace key matching the setPrompt id (e.g. "vision")
         * @param {sap.ui.base.Event} oEvent - FileUploader "change" event
         * @param {object} [mOptions]
         * @param {number} [mOptions.size=512]    - Max dimension (px) for resize
         * @param {number} [mOptions.quality=0.7] - WebP quality (0–1)
         */
        readImageAsBase64: function (sId, oEvent, mOptions) {
            const aFiles = oEvent.getParameter("files");
            const sBase = "/" + sId.replace(/^\//, "");
            const fnClear = () => {
                this.setProperty(sBase + "/image", null);
                this.setProperty(sBase + "/state", "idle");
                return Promise.resolve(null);
            };
            if (!aFiles || aFiles.length === 0) { return fnClear(); }
            const oFile = aFiles[0];
            if (!oFile.type.startsWith("image/")) { return fnClear(); }
            const iImageSize = (mOptions && mOptions.size) || 512;
            const iImageQuality = (mOptions && mOptions.quality) !== undefined ? mOptions.quality : 0.7;

            return new Promise((resolve, reject) => {
                const oReader = new FileReader();
                oReader.onload = (oReaderEvent) => {
                    const oImg = new window.Image();
                    oImg.onload = () => {
                        let { width: w, height: h } = oImg;
                        if (Math.max(w, h) > iImageSize) {
                            const scale = iImageSize / Math.max(w, h);
                            w = Math.round(w * scale);
                            h = Math.round(h * scale);
                        }
                        // eslint-disable-next-line @sap-ux/fiori-tools/sap-no-element-creation
                        const oCanvas = document.createElement("canvas");
                        oCanvas.width = w;
                        oCanvas.height = h;
                        oCanvas.getContext("2d").drawImage(oImg, 0, 0, w, h);
                        const sDataUrl = oCanvas.toDataURL("image/webp", iImageQuality);
                        if (!this.getProperty(sBase)) {
                            this.setProperty(sBase, {});
                        }
                        this.setProperty(sBase + "/image", sDataUrl);
                        this.setProperty(sBase + "/state", "idle");
                        resolve(sDataUrl);
                    };
                    oImg.onerror = reject;
                    oImg.src = oReaderEvent.target.result;
                };
                oReader.onerror = reject;
                oReader.readAsDataURL(oFile);
            });
        },

        /**
         * Converts HTML to SAPUI5 FormattedText-safe HTML.
         * sap.m.FormattedText only allows a subset of tags — unsupported ones are mapped or removed.
         * @param {string} sHtml - Raw HTML string (may contain newlines and non-standard tags)
         * @returns {string} FormattedText-compatible HTML
         */
        htmlToFormattedText: function (sHtml) {
            if (!sHtml) { return ""; }
            let s = sHtml
                .replace(/\n\n/g, "<br>")      // paragraph breaks → line break
                .replace(/\n/g, "<br>")         // remaining line breaks
                .replace(/<b(\s[^>]*)?>/gi, "<strong$1>")   // <b> → <strong>
                .replace(/<\/b>/gi, "</strong>")
                .replace(/<i(\s[^>]*)?>/gi, "<em$1>")       // <i> → <em>
                .replace(/<\/i>/gi, "</em>")
                .replace(/<(\/?)div[^>]*>/gi, "<$1p>")      // <div> → <p>
                .replace(/<(strike|s|del)(\s[^>]*)?>/gi, "<s$2>")  // → <s> (FormattedText accepts it)
                .replace(/<\/(strike|del)>/gi, "</s>");
            if (!/^\s*<(p|h[1-6]|ul|ol|pre|blockquote|table|hr)/i.test(s)) {
                s = "<p>" + s + "</p>";
            }
            return s;
        },

        _parseDataUrl: function (sDataUrl) {
            const oMatch = /^data:([^;]+);base64,(.+)$/s.exec(sDataUrl);
            const sMediaType = oMatch ? oMatch[1] : "image/jpeg";
            const sData = oMatch ? oMatch[2] : sDataUrl;
            // eslint-disable-next-line camelcase
            return { media_type: sMediaType, data: sData };
        },

        _resolveTemplate: function (sTemplate, oOptions) {
            const params = oOptions?.params || {};
            const maps = oOptions?.maps || {};

            return sTemplate.replace(/\{([^{}]+)\}/g, (match, expr) => {
                const s = expr.trim();

                if (s.startsWith("param>")) {
                    return params[s.slice(6)] ?? "";
                }

                const mapMatch = s.match(/^(\w+)>(\/[^|]*)(?:\|(.+))?$/);
                if (mapMatch) {
                    const [, mapName, path, fallback] = mapMatch;
                    const oMap = maps[mapName];
                    if (oMap) {
                        const key = this.getProperty(path.trim());
                        return oMap[key] ?? (fallback !== undefined ? oMap[fallback] ?? "" : "");
                    }
                }

                if (s.startsWith("/")) {
                    return this.getProperty(s) ?? "";
                }

                return match;
            });
        },

        _dedent: function (s) {
            const aLines = s.split("\n");
            const nMin = aLines
                .filter(l => l.trim().length > 0)
                .reduce((n, l) => Math.min(n, l.match(/^ */)[0].length), Infinity);
            return aLines.map(l => l.slice(nMin)).join("\n").trim();
        },

        _getUi5ThemeIsDark: function () {
            try {
                let sTheme;
                if (sap.ui.core?.Theming?.getTheme) {
                    sTheme = sap.ui.core.Theming.getTheme();
                } else {
                    sTheme = sap.ui.getCore().getConfiguration().getTheme();
                }
                return /dark|hcb/i.test(sTheme);
            } catch {
                return false;
            }
        },

        _loadMarked: function () {
            const bDark = this._getUi5ThemeIsDark();
            // eslint-disable-next-line @sap-ux/fiori-tools/sap-no-hardcoded-url
            const sCssHref = "https://cdn.jsdelivr.net/npm/github-markdown-css/github-markdown-"
                + (bDark ? "dark" : "light") + ".min.css";

            // eslint-disable-next-line @sap-ux/fiori-tools/sap-browser-api-warning, @sap-ux/fiori-tools/sap-no-dom-access
            let oLink = document.getElementById("github-markdown-css");
            if (!oLink) {
                // eslint-disable-next-line @sap-ux/fiori-tools/sap-no-element-creation
                oLink = document.createElement("link");
                oLink.id = "github-markdown-css";
                oLink.rel = "stylesheet";
                // eslint-disable-next-line @sap-ux/fiori-tools/sap-no-dom-insertion
                document.head.appendChild(oLink);
            }
            if (oLink.dataset.theme !== (bDark ? "dark" : "light")) {
                oLink.href = sCssHref;
                oLink.dataset.theme = bDark ? "dark" : "light";
            }

            if (_markedPromise) { return _markedPromise; }
            _markedPromise = new Promise((resolve, reject) => {
                if (window.marked) { resolve(window.marked); return; }
                // eslint-disable-next-line @sap-ux/fiori-tools/sap-browser-api-warning, @sap-ux/fiori-tools/sap-no-dom-access
                let oScript = document.getElementById("marked-script");
                if (!oScript) {
                    // eslint-disable-next-line @sap-ux/fiori-tools/sap-no-element-creation
                    oScript = document.createElement("script");
                    oScript.id = "marked-script";
                    // eslint-disable-next-line @sap-ux/fiori-tools/sap-no-hardcoded-url
                    oScript.src = "https://cdn.jsdelivr.net/npm/marked/marked.min.js";
                    // eslint-disable-next-line @sap-ux/fiori-tools/sap-no-dom-insertion
                    document.head.appendChild(oScript);
                }
                oScript.addEventListener("load", () => resolve(window.marked));
                oScript.addEventListener("error", reject);
            });
            return _markedPromise;
        },

        _mdToHtml: async function (sMd) {
            const marked = await this._loadMarked();
            return marked.parse(sMd);
        },

        /**
         * @param {sap.ui.core.Control} oControl - The control to style after rendering
         * @param {string} sStyle - Inline CSS string to apply via the style attribute
         * @example
         * this._attachStyleDelegate(oLabel, "color: red; font-weight: bold;");
         */
        _attachStyleDelegate: function (oControl, sStyle) {
            var oDelegate = {
                onAfterRendering: function () {
                    oControl.$().attr("style", sStyle);
                }
            };

            oControl.addEventDelegate(oDelegate);

            // add reference to be destroyed later
            this._oDelegates.push({ control: oControl, delegate: oDelegate });
        }
    });

    ClaudeJSONModel.calcCost = function (oUsage, sModel) {
        if (!oUsage || !sModel) { return 0; }

        // Pricing by Tier (2026-05-05)
        const mPricingTier = {
            "opus": { in: 15, out: 75 },
            "sonnet": { in: 3, out: 15 },
            "haiku": { in: 0.8, out: 4 }
        };

        // Mapping Model → Tier (incl. new models like wie 4-6)
        let sTier = null;
        if (sModel.includes("opus")) {
            sTier = "opus";
        } else if (sModel.includes("sonnet")) {
            sTier = "sonnet";
        } else if (sModel.includes("haiku")) {
            sTier = "haiku";
        }

        const mP = mPricingTier[sTier];

        if (!mP) { return 0; }

        return (oUsage.input_tokens / 1e6) * mP.in +
            (oUsage.output_tokens / 1e6) * mP.out;
    };

    return ClaudeJSONModel;
});

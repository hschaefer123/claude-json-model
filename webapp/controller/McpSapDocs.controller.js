sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/m/MessageToast",
    "../model/ClaudeJSONModel",
    "sap/m/library"
], (Controller, MessageToast, ClaudeJSONModel, mobileLibrary) => {
    "use strict";

    const MODEL_ID = "search";
    const FETCH_MODEL_ID = "fetch";
    const URLHelper = mobileLibrary.URLHelper;

    return Controller.extend("claude.controller.McpSapDocs", {

        onInit: function () {
            (async () => {
                // model init
                this._oModel = new ClaudeJSONModel({
                    maxTokens: 1500,
                    mcpServers: [{
                        type: "url",
                        // eslint-disable-next-line @sap-ux/fiori-tools/sap-no-hardcoded-url
                        url: "https://mcp-sap-docs.marianzeis.de/mcp",
                        name: "sap-docs"
                    }],
                    data: {
                        userPrompt: "",
                        selectedLimit: 3,
                        ready: false,
                        loadingText: "",
                        launchMode: "EXTERNAL"
                    }
                });
                this.getView().setModel(this._oModel);

                // watcher (vue like)
                this._oModel.watch("/userPrompt", (v) => {
                    this._oModel.setProperty("/ready", !!v);
                });
            })();
        },

        onSearch: async function () {
            if (this._oModel.getProperty("/userPrompt").trim().length === 0) {
                return;
            }

            await this._oModel.setPrompt(MODEL_ID, `
                Search SAP documentation for: "{/userPrompt}"

                Use the sap-docs search tool with these parameters:
                - query: "{/userPrompt}"
                - k: {/selectedLimit}
                - includeOnline: true
                - includeSamples: false
                `, {
                outputExample: [{
                    id: "...",
                    score: 0.036885245901639344,
                    title: "What Are SAP Fiori Annotations?",
                    snippet: "SAP Fiori elements apps are generic front ends... Maximum 120 words",
                    // eslint-disable-next-line @sap-ux/fiori-tools/sap-no-hardcoded-url
                    url: "https://...",
                    metadata: {
                        source: "cap",
                        sourceKind: "offline",
                        library: "/cap",
                        rank: 1
                    }
                }],
                mapper: (uc) => ({
                    ...uc,
                    snippet: this._oModel.htmlToFormattedText(uc.snippet)
                })
            });
        },

        onFetch: function (oEvent) {
            const oCtx = oEvent.getSource().getBindingContext();
            const oData = oCtx.getObject();

            this._oModel.showDialog({
                id: FETCH_MODEL_ID,
                title: oData.title || "SAP Documentation",
                owner: this.getView(),
                contentType: "markdown",
                content: this._oModel.setPrompt(FETCH_MODEL_ID, `
                    Fetch the full content of this SAP documentation document: "{param>docId}"
                    Use the sap-docs fetch tool with id: "{param>docId}"
                    Then summarize the key points relevant to: "{/userPrompt}"
                    `, {
                    params: {
                        docId: oData.id
                    }
                })
            });
        },

        onShowSource: function (oEvent) {
            const oData = oEvent.getSource().getBindingContext().getObject();
            URLHelper.redirect(oData.url, true);
        },

        onShowPrompt: function () {
            this._oModel.openPromptDialog(MODEL_ID, this.getView());
        }

    });
});

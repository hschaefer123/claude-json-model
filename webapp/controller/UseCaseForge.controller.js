sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/m/MessageToast",
    "../model/ClaudeJSONModel"
], (Controller, MessageToast, ClaudeJSONModel) => {
    "use strict";

    const MODEL_ID = "useCases";
    const DEEP_DIVE_MODEL_ID = "deepDive";

    return Controller.extend("claude.controller.UseCaseForge", {

        onInit: function () {
            (async () => {
                // model init
                this._oModel = new ClaudeJSONModel({
                    maxTokens: 1500,
                    data: {
                        selectedIndustry: "",
                        sapFocus: "",
                        ready: false,
                        loadingText: ""
                    }
                });
                this.getView().setModel(this._oModel);

                // watcher (vue like)
                this._oModel.watch("/selectedIndustry", (v) => {
                    this._oModel.setProperty("/ready", !!v);
                });
            })();
        },

        onGenerate: async function () {
            if (!this._oModel.getProperty("/selectedIndustry")) { return; }

            const sFocus = this._oModel.getProperty("/sapFocus");

            await this._oModel.setPrompt(MODEL_ID, `
                You are an SAP AI use case consultant.
                Generate exactly 3 concrete, practice-oriented AI use cases
                for the industry "{/selectedIndustry}".{param>focusPart}
                Be specific and close to SAP solutions.
                `, {
                params: {
                    focusPart: sFocus ? ` SAP-Focus: ${sFocus}.` : ""
                },
                outputExample: [{
                    name: "Title max 6 words",
                    desc: "What AI concretely does, 2 sentences.",
                    impact: 85,
                    effort: 35,
                    horizon: "Q3 2025",
                    tags: ["SAP-Module", "AI-Technique"],
                    sap: "SAP-Product"
                }],
                constraints: {
                    impact: { type: "integer", min: 10, max: 99 },
                    effort: { type: "integer", min: 10, max: 99 }
                },
                mapper: (uc, i) => ({
                    ...uc,
                    index: i + 1,
                    impact: Math.round(uc.impact),
                    effort: Math.round(uc.effort)
                })
            });
        },

        onDeepDive: function (oEvent) {
            const oCtx = oEvent.getSource().getBindingContext();
            const oData = oCtx.getObject();

            this._oModel.showDialog({
                id: DEEP_DIVE_MODEL_ID,
                title: oData.name,
                owner: this.getView(),
                content: this._oModel.setPrompt(DEEP_DIVE_MODEL_ID, `
                    Create a structured deep dive for the AI use case "{param>name}" 
                    in the industry "{/selectedIndustry}".

                    Outline:
                    1. Problem Statement & Business Value
                    2. Technical Architecture on SAP BTP (services, components)
                    3. Implementation Plan (3 phases)
                    4. ROI Estimation (qualitative)
                    5. Risks & Mitigations

                    Reply concise, max 400 words.
                `, {
                    params: { name: oData.name },
                    responseType: "markdown"
                })
            });
        },

        onShowPrompt: function () {
            this._oModel.openPromptDialog(MODEL_ID, this.getView());
        }

    });
});
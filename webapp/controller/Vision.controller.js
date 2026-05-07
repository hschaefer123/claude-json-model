sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/m/MessageToast",
    "sap/m/IconTabFilter",
    "sap/m/TextArea",
    "../model/ClaudeJSONModel"
], (Controller, MessageToast, IconTabFilter, TextArea, ClaudeJSONModel) => {
    "use strict";

    const MODEL_ID = "vision";

    return Controller.extend("claude.controller.Vision", {

        onInit: function () {
            (async () => {
                // model init
                this._oModel = new ClaudeJSONModel({
                    maxTokens: 1500,
                    data: {
                        size: "S",
                        languages: ["de", "en"],
                        ready: false
                    }
                });
                this.getView().setModel(this._oModel);

                const mOptions = {
                    S: { size: 512, quality: 0.80 },
                    M: { size: 1024, quality: 0.85 },
                    L: { size: 1568, quality: 0.88 }
                };

                // watcher (vue like)
                this._oModel.watch("size", (v) => {
                    this._mOptions = mOptions[v] || mOptions.S;
                });
                this._mOptions = mOptions[this._oModel.getProperty("size")] || mOptions.S;
            })();
        },

        onFileChange: async function (oEvent) {
            const sImage = await this._oModel.readImageAsBase64(MODEL_ID, oEvent, this._mOptions);

            this._oModel.setProperty("/ready", !!(sImage && sImage.length > 0));

            if (sImage) {
                this.onVisualize();
            }
        },

        onVisualize: async function () {
            await this._oModel.setPrompt(MODEL_ID, `
                Describe this image in the following languages: {/languages}.
            `, {
                outputExample: [
                    { language: "de", description: "Bildbeschreibung auf Deutsch" },
                    { language: "en", description: "Image description in English" }
                ],
                image: this._oModel.getImage(MODEL_ID)
            });
        },

        onShowPrompt: function () {
            this._oModel.openPromptDialog(MODEL_ID, this.getView());
        }

    });
});

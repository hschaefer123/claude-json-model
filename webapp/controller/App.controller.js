sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/base/i18n/Localization",
    "sap/ui/core/Theming",
    "sap/ui/core/EventBus",
    "sap/ui/model/json/JSONModel",
    "../model/ClaudeJSONModel"
], (Controller, Localization, Theming, EventBus, JSONModel, ClaudeJSONModel) => {
    "use strict";

    return Controller.extend("claude.controller.App", {

        onInit: function () {
            // eslint-disable-next-line camelcase
            this.getView().setModel(new JSONModel({ totalUsage: { input_tokens: 0, output_tokens: 0 }, costDisplay: "" }), "session");
            EventBus.getInstance().subscribe("claude.model", "usageCost", this._onUsageCost, this);

            const oParams = new URLSearchParams(window.location.search);

            this._sBrowserLang = Localization.getLanguage().substring(0, 2);
            this._sOsThemeKey = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

            const sLangParam = oParams.get("lang");
            if (sLangParam) {
                Localization.setLanguage(sLangParam);
            }
            this.byId("langSwitch").setSelectedKey(Localization.getLanguage().substring(0, 2));

            const sThemeKey = oParams.get("theme") || this._sOsThemeKey;
            this.byId("themeSwitch").setSelectedKey(sThemeKey);
            Theming.setTheme(sThemeKey === "dark" ? "sap_horizon_dark" : "sap_horizon");
        },

        onLanguageSwitch: function (oEvent) {
            const sLang = oEvent.getParameter("item").getKey();
            Localization.setLanguage(sLang);
            this._updateUrlParam("lang", sLang, this._sBrowserLang);
        },

        onThemeSwitch: function (oEvent) {
            const sKey = oEvent.getParameter("item").getKey();
            Theming.setTheme(sKey === "dark" ? "sap_horizon_dark" : "sap_horizon");
            this._updateUrlParam("theme", sKey, this._sOsThemeKey);
        },

        onExit: function () {
            EventBus.getInstance().unsubscribe("claude.model", "usageCost", this._onUsageCost, this);
        },

        _onUsageCost: function (sChannel, sEvent, oData) {
            const oModel = this.getView().getModel("session");
            const oTotalUsage = oModel.getProperty("/totalUsage");
            // eslint-disable-next-line camelcase
            oTotalUsage.input_tokens += oData.usage.input_tokens || 0;
            // eslint-disable-next-line camelcase
            oTotalUsage.output_tokens += oData.usage.output_tokens || 0;
            oModel.setProperty("/totalUsage", oTotalUsage);
            const nTotal = ClaudeJSONModel.calcCost(oTotalUsage, oData.model);
            oModel.setProperty("/costDisplay", nTotal > 0 ? "~$" + (nTotal < 0.00001 ? nTotal.toExponential(2) : nTotal.toFixed(5)) : "");
        },

        navTo: function (sRoute) {
            this.getOwnerComponent().getRouter().navTo(sRoute);
        },

        _updateUrlParam: function (sParam, sValue, sDefault) {
            const oUrl = new URL(window.location.href);
            if (sValue === sDefault) {
                oUrl.searchParams.delete(sParam);
            } else {
                oUrl.searchParams.set(sParam, sValue);
            }
            window.history.replaceState(null, "", oUrl.toString());
        }

    });
});
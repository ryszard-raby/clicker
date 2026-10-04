// ==UserScript==
// @name         Yolo
// @namespace    http://tampermonkey.net/
// @version      2026-10-04
// @description  try to take over the world!
// @author       You
// @match        https://*/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=ceneo.pl
// @require      file:///C:/_git/clickator/dist/clickator.js
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getTab
// @grant        GM_saveTab
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      api.typesafe.ai
// @connect      api.openai.com
// ==/UserScript==

(function () {
    'use strict';
    Clickator.mount({
        transport: Clickator.gmTransport(GM_xmlhttpRequest),
        store: Clickator.gmTabStore(GM_getTab, GM_saveTab),
        autoResume: true,
    });
})();

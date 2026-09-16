// content script는 chrome.tabs API를 직접 쓸 수 없으므로,
// 탭의 zoom factor 조회 / 변경 감지를 대신 수행해서 content.js로 전달만 한다.
"use strict";

// 사용자가 Ctrl +/-, Ctrl 0 등으로 페이지 줌을 바꿀 때마다 해당 탭에 새 zoom factor를 알려준다.
chrome.tabs.onZoomChange.addListener(function (zoomChangeInfo) {
  chrome.tabs.sendMessage(
    zoomChangeInfo.tabId,
    {
      type: "WSC_ZOOM_CHANGED",
      zoomFactor: zoomChangeInfo.newZoomFactor,
    },
    function () {
      // content script가 없는 탭(적용 대상 외 페이지)으로 보낼 때 발생하는 에러는 무시한다.
      void chrome.runtime.lastError;
    }
  );
});

// content.js가 처음 로드될 때 현재 탭의 zoom factor를 요청하면 응답해준다.
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message && message.type === "WSC_GET_ZOOM" && sender.tab && sender.tab.id !== undefined) {
    chrome.tabs.getZoom(sender.tab.id, function (zoomFactor) {
      sendResponse({ zoomFactor: zoomFactor });
    });
    return true; // 비동기로 sendResponse를 호출하기 위해 true를 반환한다.
  }
  return undefined;
});

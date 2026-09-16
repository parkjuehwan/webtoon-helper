# Webtoon Helper — 진행 상황 인계 문서

이 문서는 Claude Code(터미널/IDE에서 실제 파일을 수정하는 에이전트)와 진행해 온
"Webtoon Helper" Chrome Extension 프로젝트의 지금까지 진행 내용, 시행착오, 현재
코드 상태를 정리한 것이다. 앞으로는 Claude Desktop에서 다음 작업 프롬프트를 작성한
뒤 그것을 Claude Code에게 전달하는 방식으로 진행할 예정이다.

## 1. 프로젝트 개요

- **이름**: Webtoon Helper (내부 확장 이름은 manifest.json 상 `Webtoon Scroll Control`)
- **목적**: 네이버 웹툰 회차 감상 페이지에서 마우스 휠 스크롤 감도를 사용자가 직접
  조절할 수 있게 해주는 아주 단순한 Chrome Extension. 페이지 위에 작은 플로팅
  컨트롤러(제목 + 슬라이더 + 현재 감도 표시)를 띄우고, 드래그로 위치를 옮길 수 있다.
- **작업 경로**: `c:\webtoon-helper` (Chrome의 "압축해제된 확장 프로그램 로드"로 이
  폴더 자체를 그대로 로드한다. 빌드 과정 없음.)
- **기술 스택**: Manifest V3, Vanilla JS/CSS/HTML만 사용. React/Vue 등 프레임워크
  금지. popup 페이지, side panel, 별도 설정 페이지 없음.
- **작업 스타일**: 지금까지 사용자는 각 기능 요청마다 매우 구체적인 스펙(수식, 예시,
  금지 목록, 테스트 시나리오)을 프롬프트로 주고, Claude Code가 그대로 구현하는
  방식으로 진행해왔다. "이번 버전에서 절대 넣지 않을 기능" 같은 명시적 배제 목록을
  항상 함께 준다.

## 2. 현재 파일 구조

```
webtoon-helper/
├── manifest.json
├── content.js
├── content.css
├── background.js
└── HANDOFF.md   (이 문서)
```

| 파일 | 역할 |
|---|---|
| `manifest.json` | MV3 설정. content script를 `https://comic.naver.com/webtoon/detail*`에만 주입, `storage` 권한, `background.js`를 service worker로 등록 |
| `content.js` | 플로팅 패널 생성, 드래그, wheel 감도 스크롤, chrome.storage 저장/복원, 페이지 줌(Chrome zoom) 대응 로직 전부 포함. IIFE 하나로 캡슐화 |
| `content.css` | 패널 디자인 (흰 배경, 200px 너비, border-radius, box-shadow, `transform-origin: top left`) |
| `background.js` | content script가 쓸 수 없는 `chrome.tabs.getZoom` / `chrome.tabs.onZoomChange`를 대신 호출해서 메시지로 content.js에 전달하는 역할만 수행하는 최소 service worker |

## 3. 지금까지의 진행 순서와 시행착오

### 3.1 최초 구현 (1차)
요청: 휠 스크롤 감도 조절 + 드래그 가능한 플로팅 패널.
- `deltaY * sensitivity`로 스크롤량 계산, `wheel` 이벤트에 `{ passive: false }` +
  `preventDefault()` 필수 (그래야 `event.preventDefault()`가 무시되지 않음).
- 처음엔 `matches: ["<all_urls>"]`로 모든 사이트에 주입했었음.
- 감도 범위 0.2x~5.0x, step 0.1, 기본값 1.0x.
- 패널 드래그: `mousedown`(제목 영역만 drag handle) → `mousemove` → `mouseup`,
  `position: fixed` + viewport 밖으로 못 나가게 좌표 clamp.

### 3.2 부드러운 스크롤 + 입력 누락 문제 수정
문제: 감도를 3x 등으로 높이면 wheel을 연속으로 굴렸을 때 일부 입력이 반영 안 되는
것처럼 느껴지고, 스크롤이 순간이동처럼 뚝뚝 끊겨 보임.
- **원인**: debounce/throttle 코드가 있었던 게 아니라, wheel 이벤트마다
  `event.deltaY * sensitivity`를 즉시 `window.scrollBy()`로 한 번에 적용했기 때문에
  큰 값이 순간 점프로 보이고, 연속 입력이 겹치면 프레임이 밀려서 누락처럼 보인 것.
- **해결**: `pendingScroll` 누적 변수 + `requestAnimationFrame` 루프 도입.
  - wheel마다 `pendingScroll += normalizedDelta * sensitivity`만 하고, 애니메이션
    루프가 이미 돌고 있으면 새로 시작하지 않음(`animationFrameId === null`일 때만
    시작) → 입력을 버리지 않고 전부 누적.
  - 매 프레임 `step = pendingScroll * 0.2`만큼 이동, 잔여값이 0.5px 미만이면 그
    나머지를 한 번에 적용하고 종료 → 최종 이동 거리가 `wheel 입력 합 × sensitivity`와
    정확히 일치하도록 보장.
  - `behavior: "smooth"`는 사용하지 않음 (브라우저 자체 smooth scroll과 우리
    애니메이션이 겹치는 걸 방지, `window.scrollBy(0, step)`만 사용).
- `WheelEvent.deltaMode`(PIXEL/LINE/PAGE)를 픽셀로 정규화하는
  `normalizeWheelDeltaY()` 추가.
- 패널 내부(슬라이더 등)에서 발생한 wheel은 `panel.contains(event.target)`으로
  걸러서 그대로 기본 동작에 맡김 (슬라이더 조작 중 페이지가 같이 스크롤되는 문제 방지).

### 3.3 적용 사이트 범위 제한
요청: 네이버 웹툰의 "실제 회차 감상 페이지"에서만 동작해야 함 (목록 페이지, 네이버
메인, 다른 사이트 전부 제외). content script 자체가 주입 안 되게 해야 함(런타임에
숨기는 방식 금지).
- `manifest.json`의 `matches`를 `<all_urls>` → `https://comic.naver.com/webtoon/detail*`로 변경.
- **중요 포인트**: Chrome match pattern에서 path 뒤의 `*`는 그 뒤의 나머지 경로 +
  query string 전체를 포함해서 매칭된다. 그래서 `titleId`, `no`, `week` 값이 뭐든
  `/webtoon/detail?...`이기만 하면 매칭되고, `/webtoon/list?...`는 매칭 안 됨.

### 3.4 설정값(감도) / 패널 위치 유지 (chrome.storage.local)
요청: 새로고침/다음 화 이동/탭 재오픈에도 감도와 패널 위치가 유지되어야 함. 작품·
회차별이 아니라 확장 전체 공통 설정. `chrome.storage.local`만 사용(localStorage 금지).
- `manifest.json`에 `"permissions": ["storage"]` 추가.
- 저장 키: `sensitivity`(number), `panelPosition`(당시엔 `{left, top}` — 이후 3.6에서
  구조 변경됨).
- 저장 시점: 슬라이더 `input` 이벤트마다 감도 저장 / 드래그 `mouseup` 시점에 위치 저장.
- 로드 시점: content script 시작 시 `chrome.storage.local.get(...)` 콜백 안에서
  패널을 생성 → 깜빡임 없이 저장된 값으로 바로 시작.
- 저장된 위치가 현재 viewport 밖이면 화면 안쪽으로 clamp해서 패널이 화면 밖에 생기지
  않게 처리.

### 3.5 Ctrl+휠 확대/축소와 충돌하는 문제
문제: wheel 핸들러가 `ctrlKey` 여부를 구분하지 않고 무조건 `preventDefault()` +
`scrollBy()`를 실행해서, Ctrl+휠(또는 트랙패드 핀치, 둘 다 `ctrlKey: true`인 wheel
이벤트로 들어옴)로 화면을 확대/축소하려 해도 페이지가 스크롤되어버림.
- **해결**: wheel 핸들러 맨 앞에 `if (event.ctrlKey) return;` 추가. 패널 내부 이벤트
  체크와 동일하게 그냥 아무 처리 없이 브라우저 기본 동작(줌)에 맡김.

### 3.6 Chrome 페이지 줌 대응 — 1단계: 크기 고정
문제: Chrome 페이지 줌(Ctrl +/-, Ctrl 0, 50%~200% 등)을 바꾸면 플로팅 패널도 같이
커지거나 작아짐. 목표는 웹툰 본문만 확대/축소되고 컨트롤러의 "시각적 크기"는 항상
100% 줌 기준으로 고정되는 것.
- **핵심 제약**: `chrome.tabs.getZoom` / `chrome.tabs.onZoomChange`는 content
  script에서 직접 호출 불가 → **`background.js` service worker를 새로 추가**해서
  탭의 zoom factor 조회/변경 감지를 대신 하고 `chrome.runtime.sendMessage` /
  `chrome.tabs.sendMessage`로 content.js와 메시지를 주고받음.
  - `getZoom`, `setZoom`, `onZoomChange` 등 zoom 관련 API는 `"tabs"` permission이
    필요 없음 (최소 권한 원칙 유지, `"tabs"` 추가 안 함).
  - `manifest.json`에 `"background": { "service_worker": "background.js" }` 추가.
- **크기 고정 방법**: `panel.style.transform = "scale(1 / zoomFactor)"`. 페이지 줌이
  작아지면(zoomFactor < 1) scale이 커지고, 줌이 커지면(zoomFactor > 1) scale이
  작아져서 서로 상쇄됨.
- `content.css`에 `transform-origin: top left` 추가 — scale이 패널의 좌상단
  모서리를 기준으로 걸리게 해서, 이후 위치 계산을 left/top 좌표계와 어긋나지 않게
  통일시킴 (이 결정이 3.7에서도 계속 재사용됨).
- 줌이 바뀔 때마다 `chrome.tabs.onZoomChange` → background.js가 감지 →
  `WSC_ZOOM_CHANGED` 메시지를 해당 탭의 content.js로 전달 → 즉시 scale 갱신
  (새로고침 없이 실시간 반영).
- `window.resize`에도 `requestAnimationFrame`으로 스로틀링한 재보정 로직을 붙여서
  브라우저 창 크기 변경/최대화·복원 시에도 패널이 화면 밖으로 안 나가게 함.

### 3.7 Chrome 페이지 줌 대응 — 2단계: 위치 고정 (가장 까다로웠던 부분)
문제: 3.6 이후 패널 **크기**는 줌과 무관하게 고정됐지만, 줌을 바꾸면 패널의 **화면상
위치**가 계속 이동함 (예: 100%에서 오른쪽 중간에 있던 패널이 50%/200%로 바꾸면
눈에 보이는 위치가 달라짐).
- **원인 분석**: 화면(모니터) 기준 실제 위치는 대략 `CSS px 좌표 × zoomFactor`로
  결정되는데, 기존 코드는 줌이 바뀌어도 `left`/`top`(CSS px) 값을 그대로 뒀다.
  크기는 scale로 상쇄했지만 위치 좌표 자체는 그대로였기 때문에, 같은 CSS 좌표라도
  줌이 바뀌면 화면상 물리적 위치가 zoomFactor에 비례해서 밀려 보인 것.
- **해결**: "화면 기준(zoom-independent) 좌표" `panelVisualX`, `panelVisualY`라는
  새로운 상태를 도입.
  - `visualX = left(css px) * zoomFactor`
  - `left(css px) = visualX / zoomFactor`
  - 패널의 "진짜" 위치는 항상 `panelVisualX/Y`이고, 화면에 그릴 때만 현재
    `zoomFactor`로 CSS `left`/`top`을 역산한다 (`updatePanelFromVisualPosition`).
  - **절대 규칙**: 줌이 바뀌는 시점에 `panelVisualX/Y`를 "현재 left/top으로부터
    다시 계산"하면 안 됨 (그 시점엔 이미 CSS 좌표가 옛날 줌 기준이라 뒤섞임 —
    이게 처음에 위치가 밀리던 버그의 원인이었음). 항상 순서는:
    1. 기존 `panelVisualX/Y` 유지
    2. 새 `zoomFactor`로 CSS 좌표 재계산
    3. viewport를 벗어날 때만 최소한으로 clamp하고, clamp된 결과를 다시
       `panelVisualX/Y`에 반영 (임의의 기본 위치로 리셋하지 않고, 딱 벗어난
       만큼만 안쪽으로 당김 — `Math.min/Math.max` 기반이라 자연히 "최소 보정"이 됨)
  - `chrome.storage.local`의 `panelPosition` 저장 형식도 `{left, top}` →
    `{visualX, visualY}`로 변경. 저장 당시 줌이 몇 %였든, 불러올 때 현재
    zoomFactor로 역산하므로 항상 같은 화면 위치로 복원됨.
  - 드래그 중에도 마우스 좌표(`event.clientX/Y`)는 이미 현재 zoom 기준 CSS px라서
    기존 계산은 그대로 두되, 매 `mousemove`마다 `panelVisualX/Y`도 함께 갱신해서
    드래그 도중 줌이 바뀌는 극단적 케이스에도 기준이 안 어긋나게 함.
  - 줌 변경 메시지 핸들러와 `window.resize` 핸들러는 둘 다
    `updatePanelFromVisualPosition(panel, true)` 한 줄만 호출하도록 통일.

### 3.8 UI 텍스트 변경
- 패널 제목: `"Scroll Control"` → `"네이버 웹툰 헬퍼"`
- 슬라이더 라벨: `"감도"` → `"휠 감도"`
- 디자인/크기/동작 로직은 변경하지 않음 (텍스트만 수정).

## 4. 명시적으로 아직 구현하지 않은 것 (사용자가 반복적으로 배제 지정한 기능)

아래는 "나중에 만들 수도 있지만 지금은 절대 넣지 말라"고 명시된 항목들이다. 앞으로
새 기능을 제안/구현할 때 이 목록에 있는 것은 사용자가 먼저 요청하기 전에는 추가하지
않아야 한다.

- 자동 스크롤, 위/아래 버튼
- 웹툰 이미지 자동 감지
- 네이버 웹툰/카카오웹툰 등 사이트별 전용 코드 (현재는 URL 범위 제한만 있음)
- 다음 화/이전 화로 자동 이동
- 키보드 단축키
- 좌우 스크롤
- 패널 투명도 조절, 패널 접기(collapse)
- 사이트별 개별 설정 프로필
- 로그인, 서버, 데이터베이스, 광고, 결제, 계정 기능
- React/Vue 등 프레임워크
- 별도 설정 페이지, popup 페이지, side panel
- chrome.tabs.setZoom으로 줌을 강제 고정하는 것 (사용자의 실제 페이지 확대/축소
  기능은 항상 정상 동작해야 함 — Webtoon Helper는 오직 컨트롤러 자체의 시각적
  크기/위치만 상쇄함)

## 5. Claude Code와 계속 작업할 때 참고할 점

- 이 프로젝트는 지금까지 "요구사항을 아주 구체적으로(수식, 예시, 금지 목록, 테스트
  시나리오까지) 명시한 프롬프트 → Claude Code가 해당 파일만 정확히 수정" 하는
  방식으로 잘 진행되어 왔다. 새 프롬프트를 작성할 때도 이 스타일(핵심 목표 → 구체적
  구현 방식/수식 → 하지 말아야 할 것 → 테스트 시나리오)을 유지하면 결과 품질이 좋다.
- 매번 "기존 코드를 먼저 확인하고 기존 구조를 최대한 유지하면서 필요한 부분만
  수정해달라"고 명시적으로 요청해왔고, Claude Code는 실제로 기존 함수/구조를 최대한
  재사용하며 필요한 부분만 고쳐왔다 (전면 재작성 지양).
- 매 작업 후 Claude Code에게 "왜 문제가 있었는지 / 무엇을 바꿨는지 간단히 설명"을
  요청하는 패턴을 사용해왔다. 계속 이 방식을 쓰면 좋다.
- 현재 `content.js`가 이 프로젝트의 핵심 로직을 전부 담고 있고 (336줄), 여기 손대는
  작업이 대부분이다. `manifest.json`, `content.css`, `background.js`는 상대적으로
  단순하다.
- 확장은 `chrome://extensions` → 개발자 모드 → "압축해제된 확장 프로그램 로드"로
  `c:\webtoon-helper` 폴더를 그대로 로드해서 테스트한다. 코드 수정 후에는 그 페이지에서
  새로고침(⟳) 버튼을 눌러야 변경 사항이 반영된다.

## 6. 현재 전체 파일 원문 (참고용 스냅샷)

### manifest.json
```json
{
  "manifest_version": 3,
  "name": "Webtoon Scroll Control",
  "version": "1.0.0",
  "description": "마우스 휠 스크롤 감도를 조절하는 플로팅 컨트롤러",
  "permissions": ["storage"],
  "background": {
    "service_worker": "background.js"
  },
  "content_scripts": [
    {
      "matches": ["https://comic.naver.com/webtoon/detail*"],
      "js": ["content.js"],
      "css": ["content.css"],
      "run_at": "document_idle"
    }
  ]
}
```

### background.js
```js
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
```

### content.css
```css
/* 플로팅 컨트롤 패널 스타일 */
#webtoon-scroll-control-panel {
  position: fixed;
  top: 150px;
  right: 30px;
  width: 200px;
  background: #ffffff;
  border-radius: 10px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
  z-index: 2147483647; /* 항상 최상단에 노출 */
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  color: #222222;
  overflow: hidden;
  user-select: none;
  transform-origin: top left; /* Chrome 페이지 줌 상쇄용 scale의 기준점 */
}

/* 드래그 핸들 역할을 하는 제목 영역 */
.wsc-header {
  padding: 8px 12px;
  background: #f3f3f3;
  font-weight: 600;
  cursor: move;
  border-bottom: 1px solid #e2e2e2;
}

.wsc-body {
  padding: 10px 12px;
}

.wsc-label {
  margin-bottom: 6px;
  color: #555555;
}

.wsc-slider {
  width: 100%;
  cursor: pointer;
}

.wsc-value {
  margin-top: 6px;
  text-align: center;
  font-weight: 600;
  color: #333333;
}

/* 드래그 중 텍스트 선택 방지 */
.wsc-no-select,
.wsc-no-select * {
  user-select: none !important;
}
```

### content.js
```js
// 웹툰 스크롤 감도 컨트롤러
// 페이지 코드와의 충돌을 막기 위해 즉시 실행 함수(IIFE)로 감싼다.
(function () {
  "use strict";

  const PANEL_ID = "webtoon-scroll-control-panel";

  // 동일한 컨텐츠 스크립트가 중복 실행되어도 패널이 두 번 생기지 않도록 방지
  if (document.getElementById(PANEL_ID)) {
    return;
  }

  // ---- 감도 설정값 ----
  const MIN_SENSITIVITY = 0.2;
  const MAX_SENSITIVITY = 5.0;
  const SENSITIVITY_STEP = 0.1;
  const DEFAULT_SENSITIVITY = 1.0;

  // ---- chrome.storage.local 키 (작품/회차 구분 없이 공통 설정) ----
  const STORAGE_KEY_SENSITIVITY = "sensitivity";
  const STORAGE_KEY_PANEL_POSITION = "panelPosition";

  let sensitivity = DEFAULT_SENSITIVITY;
  let zoomFactor = 1; // Chrome 페이지 줌 배율 (background.js가 알려준다)
  let currentPanel = null; // 줌 변경 / 창 크기 변경 핸들러에서 참조

  // 패널의 "화면(모니터) 기준" 위치. CSS left/top처럼 zoom에 따라 값이 변하지 않는
  // 좌표계로, zoom이 바뀔 때마다 이 값을 기준으로 CSS 좌표를 다시 계산한다.
  let panelVisualX = 0;
  let panelVisualY = 0;

  // 저장된 값이 손상되었거나 범위를 벗어난 경우를 대비한 보정
  function clampSensitivity(value) {
    if (typeof value !== "number" || Number.isNaN(value)) {
      return DEFAULT_SENSITIVITY;
    }
    return Math.min(Math.max(value, MIN_SENSITIVITY), MAX_SENSITIVITY);
  }

  // ---- 패널 위치 / 크기 유틸 ----
  // transform-origin: top left 이므로 scale을 적용해도 left/top(박스의 좌상단)은
  // 그대로이고, 실제로 화면에 보이는 크기만 offsetWidth/offsetHeight * scale이 된다.
  function getScaledPanelSize(panel) {
    const scale = 1 / zoomFactor;
    return {
      width: panel.offsetWidth * scale,
      height: panel.offsetHeight * scale,
    };
  }

  // 패널이 현재 viewport 안쪽(실제로 보이는 크기 기준)에 머물도록 좌표를 보정한다.
  function clampPosition(panel, left, top) {
    const { width, height } = getScaledPanelSize(panel);
    const maxLeft = Math.max(0, window.innerWidth - width);
    const maxTop = Math.max(0, window.innerHeight - height);
    return {
      left: Math.min(Math.max(0, left), maxLeft),
      top: Math.min(Math.max(0, top), maxTop),
    };
  }

  function setPanelPosition(panel, left, top) {
    panel.style.left = left + "px";
    panel.style.top = top + "px";
    panel.style.right = "auto";
  }

  // CSS px(zoom에 따라 화면상 크기가 달라짐) <-> 화면 기준 좌표(zoom과 무관) 변환.
  // 예) 100% zoom에서 left=1400 -> visualX=1400. 이후 200% zoom이 되면
  //     left = visualX / 2 = 700 이 되어, 화면상 보이는 위치는 그대로 유지된다.
  function cssToVisual(cssValue) {
    return cssValue * zoomFactor;
  }
  function visualToCss(visualValue) {
    return visualValue / zoomFactor;
  }

  // panelVisualX/Y(화면 기준 위치)를 "현재" zoomFactor로 CSS 좌표로 변환해서 적용한다.
  // 필요한 경우에만(viewport를 벗어날 때만) 최소한으로 clamp하고, clamp된 결과를
  // 다시 panelVisualX/Y에 반영해서 다음 줌 변경의 기준으로 삼는다.
  function updatePanelFromVisualPosition(panel, clamp) {
    let left = visualToCss(panelVisualX);
    let top = visualToCss(panelVisualY);

    if (clamp) {
      const clamped = clampPosition(panel, left, top);
      left = clamped.left;
      top = clamped.top;
      panelVisualX = cssToVisual(left);
      panelVisualY = cssToVisual(top);
    }

    setPanelPosition(panel, left, top);
  }

  // 페이지 줌(zoomFactor)의 반대 배율로 scale을 걸어서 시각적 크기를 상쇄한다.
  // 예) 페이지 50%(0.5) -> scale 2, 페이지 200%(2) -> scale 0.5
  function applyPanelScale(panel) {
    const scale = 1 / zoomFactor;
    panel.style.transform = "scale(" + scale + ")";
  }

  // ---- 플로팅 패널 생성 ----
  function createPanel(initialSensitivity) {
    const panel = document.createElement("div");
    panel.id = PANEL_ID;

    const header = document.createElement("div");
    header.className = "wsc-header";
    header.textContent = "네이버 웹툰 헬퍼";

    const body = document.createElement("div");
    body.className = "wsc-body";

    const label = document.createElement("div");
    label.className = "wsc-label";
    label.textContent = "휠 감도";

    const slider = document.createElement("input");
    slider.type = "range";
    slider.className = "wsc-slider";
    slider.min = String(MIN_SENSITIVITY);
    slider.max = String(MAX_SENSITIVITY);
    slider.step = String(SENSITIVITY_STEP);
    slider.value = String(initialSensitivity);

    const valueDisplay = document.createElement("div");
    valueDisplay.className = "wsc-value";
    valueDisplay.textContent = initialSensitivity.toFixed(1) + "x";

    // 슬라이더를 움직이면 감도 값과 화면 표시를 갱신하고, 즉시 storage에 저장한다.
    slider.addEventListener("input", function (event) {
      sensitivity = parseFloat(event.target.value);
      valueDisplay.textContent = sensitivity.toFixed(1) + "x";
      chrome.storage.local.set({ [STORAGE_KEY_SENSITIVITY]: sensitivity });
    });

    body.appendChild(label);
    body.appendChild(slider);
    body.appendChild(valueDisplay);

    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);

    return { panel, header };
  }

  // ---- 패널 드래그 이동 ----
  function enableDrag(panel, dragHandle) {
    let isDragging = false;
    let grabOffsetX = 0;
    let grabOffsetY = 0;

    dragHandle.addEventListener("mousedown", function (event) {
      isDragging = true;

      const rect = panel.getBoundingClientRect();
      grabOffsetX = event.clientX - rect.left;
      grabOffsetY = event.clientY - rect.top;

      document.body.classList.add("wsc-no-select");
      event.preventDefault();
    });

    document.addEventListener("mousemove", function (event) {
      if (!isDragging) return;

      // event.clientX/Y는 현재 zoom 기준 CSS px 좌표이므로 그대로 left/top 계산에 쓴다.
      const nextLeft = event.clientX - grabOffsetX;
      const nextTop = event.clientY - grabOffsetY;

      // 패널이 viewport 밖으로 완전히 나가지 않도록 좌표 제한 (줌 배율 반영)
      const clamped = clampPosition(panel, nextLeft, nextTop);
      setPanelPosition(panel, clamped.left, clamped.top);

      // 화면 기준 위치도 같이 갱신해서 드래그 중 줌이 바뀌어도 기준이 어긋나지 않게 한다.
      panelVisualX = cssToVisual(clamped.left);
      panelVisualY = cssToVisual(clamped.top);
    });

    document.addEventListener("mouseup", function () {
      if (!isDragging) return;
      isDragging = false;
      document.body.classList.remove("wsc-no-select");

      // 드래그가 끝난 시점의 화면 기준 위치(zoom과 무관한 좌표)를 저장한다.
      chrome.storage.local.set({
        [STORAGE_KEY_PANEL_POSITION]: { visualX: panelVisualX, visualY: panelVisualY },
      });
    });
  }

  // ---- wheel delta를 pixel 단위로 정규화 ----
  // deltaMode가 LINE/PAGE 단위로 오는 브라우저/입력장치가 있어 그대로 쓰면 감도 계산이 어긋난다.
  const LINE_HEIGHT_PX = 16; // 한 줄당 대략적인 픽셀 값
  function normalizeWheelDeltaY(event) {
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      return event.deltaY * LINE_HEIGHT_PX;
    }
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      return event.deltaY * window.innerHeight;
    }
    return event.deltaY; // DOM_DELTA_PIXEL
  }

  // ---- 마우스 휠 스크롤 감도 조절 ----
  function enableScrollControl(panel) {
    let pendingScroll = 0; // 아직 화면에 반영되지 않고 누적된 스크롤량
    let animationFrameId = null;
    const EASE_FACTOR = 0.2; // 프레임마다 남은 거리의 이 비율만큼 이동
    const REMAINING_THRESHOLD = 0.5; // 이 값보다 작아지면 한 번에 마무리

    // requestAnimationFrame 루프: pendingScroll이 소진될 때까지 조금씩 스크롤한다.
    function animateScroll() {
      if (Math.abs(pendingScroll) < REMAINING_THRESHOLD) {
        // 남은 이동량을 그대로 적용해서 최종 이동 거리가 정확히 맞도록 마무리
        window.scrollBy(0, pendingScroll);
        pendingScroll = 0;
        animationFrameId = null;
        return;
      }

      const step = pendingScroll * EASE_FACTOR;
      window.scrollBy(0, step);
      pendingScroll -= step;
      animationFrameId = requestAnimationFrame(animateScroll);
    }

    window.addEventListener(
      "wheel",
      function (event) {
        // 패널(슬라이더 등) 위에서 발생한 휠 이벤트는 그대로 브라우저 기본 동작에 맡긴다.
        if (panel.contains(event.target)) {
          return;
        }

        // Ctrl(또는 트랙패드 핀치 제스처)과 함께 휠을 굴리면 브라우저 확대/축소 동작이므로 그대로 둔다.
        if (event.ctrlKey) {
          return;
        }

        // 기본 스크롤을 막고, 감도가 적용된 이동량을 누적한다.
        event.preventDefault();
        const normalizedDelta = normalizeWheelDeltaY(event);
        pendingScroll += normalizedDelta * sensitivity;

        // 애니메이션이 이미 돌고 있다면 새로 시작하지 않고 누적값만 반영되게 둔다.
        if (animationFrameId === null) {
          animationFrameId = requestAnimationFrame(animateScroll);
        }
      },
      { passive: false } // preventDefault()를 사용하기 위해 반드시 필요
    );
  }

  // ---- Chrome 페이지 줌 대응 ----

  // background.js에 현재 탭의 zoom factor를 물어본다. (content script는 chrome.tabs를 직접 못 씀)
  function requestInitialZoomFactor(callback) {
    try {
      chrome.runtime.sendMessage({ type: "WSC_GET_ZOOM" }, function (response) {
        if (chrome.runtime.lastError || !response) {
          callback(1);
          return;
        }
        callback(response.zoomFactor || 1);
      });
    } catch (error) {
      callback(1);
    }
  }

  // background.js가 chrome.tabs.onZoomChange를 감지해서 전달해주는 메시지를 받는다.
  chrome.runtime.onMessage.addListener(function (message) {
    if (!currentPanel || !message || message.type !== "WSC_ZOOM_CHANGED") {
      return;
    }
    // 화면 기준 위치(panelVisualX/Y)는 그대로 두고, 새 zoomFactor로 CSS 좌표만 다시 계산한다.
    // (여기서 현재 left/top을 다시 읽어 visual로 되돌리면 안 된다 — 그게 위치가 밀리던 원인이었다.)
    zoomFactor = message.zoomFactor || 1;
    applyPanelScale(currentPanel);
    updatePanelFromVisualPosition(currentPanel, true);
  });

  // 브라우저 창 크기 변경(최대화/복원 포함) 시에도 패널이 화면 밖으로 나가지 않도록 보정한다.
  // zoomFactor는 그대로이므로 공간이 충분하면 위치가 전혀 변하지 않고, 벗어날 때만 clamp된다.
  let resizeFrameId = null;
  window.addEventListener("resize", function () {
    if (!currentPanel || resizeFrameId !== null) return;
    resizeFrameId = requestAnimationFrame(function () {
      resizeFrameId = null;
      updatePanelFromVisualPosition(currentPanel, true);
    });
  });

  // ---- 초기화 ----
  // 저장된 감도/패널 위치를 먼저 불러온 뒤 그 값을 기준으로 UI를 생성한다.
  chrome.storage.local.get(
    [STORAGE_KEY_SENSITIVITY, STORAGE_KEY_PANEL_POSITION],
    function (stored) {
      sensitivity = clampSensitivity(stored[STORAGE_KEY_SENSITIVITY]);

      const { panel, header } = createPanel(sensitivity);
      currentPanel = panel;

      // 현재 탭의 zoom factor를 먼저 받아와야 CSS px <-> 화면 기준 좌표 변환이 정확하다.
      requestInitialZoomFactor(function (initialZoomFactor) {
        zoomFactor = initialZoomFactor;
        applyPanelScale(panel);

        const savedPosition = stored[STORAGE_KEY_PANEL_POSITION];
        if (
          savedPosition &&
          typeof savedPosition.visualX === "number" &&
          typeof savedPosition.visualY === "number"
        ) {
          panelVisualX = savedPosition.visualX;
          panelVisualY = savedPosition.visualY;
        } else {
          // 저장된 값이 없으면 CSS 기본 위치(top/right)를 현재 zoom 기준으로 읽어
          // 화면 기준 좌표의 시작점으로 삼는다.
          const rect = panel.getBoundingClientRect();
          panelVisualX = cssToVisual(rect.left);
          panelVisualY = cssToVisual(rect.top);
        }

        updatePanelFromVisualPosition(panel, true);
      });

      enableDrag(panel, header);
      enableScrollControl(panel);
    }
  );
})();
```

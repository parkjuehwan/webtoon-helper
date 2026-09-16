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
  const STORAGE_KEY_AUTO_SCROLL_SPEED = "autoScrollSpeed";
  const STORAGE_KEY_BGM_AUTO_MUTE = "bgmAutoMuteEnabled";

  let sensitivity = DEFAULT_SENSITIVITY;
  // 새 회차 진입 시 자동재생되는 BGM을 자동으로 꺼줄지 여부. 기본값은 켬(true).
  let bgmAutoMuteEnabled = true;
  let bgmToggleButtonEl = null; // 패널의 BGM 토글 버튼 참조 (독립 storage.get 콜백에서 표시 갱신용)
  let zoomFactor = 1; // Chrome 페이지 줌 배율 (background.js가 알려준다)
  let currentPanel = null; // 줌 변경 / 창 크기 변경 핸들러에서 참조

  // 화살표 키 토글로 켜고 끄는 자동 스크롤 상태. sensitivity와는 완전히 독립된 값이다.
  // on/off(autoScrollDirection)는 저장하지 않고, 속도(autoScrollSpeed)만 storage에 저장한다.
  let autoScrollSpeed = DEFAULT_SENSITIVITY;
  let autoScrollDirection = 0; // 0: 정지, 1: 아래로, -1: 위로
  let autoScrollFrameId = null;
  let autoScrollLastTimestamp = null; // 직전 tick의 timestamp (delta time 계산용)

  // 패널의 "화면(모니터) 기준" 위치. CSS left/top처럼 zoom에 따라 값이 변하지 않는
  // 좌표계로, zoom이 바뀔 때마다 이 값을 기준으로 CSS 좌표를 다시 계산한다.
  let panelVisualX = 0;
  let panelVisualY = 0;

  // ---- BGM 자동재생 차단 (독립적으로, 최대한 빨리 실행) ----
  // 다른 설정(sensitivity 등)과 storage.get을 묶어서 부르면 패널 생성 전체가 끝날
  // 때까지 BGM 감시 시작이 늦어져서 자동재생 소리가 잠깐 들릴 수 있다. 그래서 이
  // 설정만 따로, 스크립트 실행 최대한 이른 시점에 독립적으로 불러와서 바로
  // 감시를 시작한다 (패널 생성이나 다른 storage.get 완료를 기다리지 않음).
  chrome.storage.local.get([STORAGE_KEY_BGM_AUTO_MUTE], function (stored) {
    bgmAutoMuteEnabled =
      typeof stored[STORAGE_KEY_BGM_AUTO_MUTE] === "boolean"
        ? stored[STORAGE_KEY_BGM_AUTO_MUTE]
        : true;

    if (bgmAutoMuteEnabled) {
      setupBgmAutoMuteWatcher();
    }

    // 패널의 BGM 토글 버튼이 이미 만들어져 있다면(패널 쪽 storage.get이 먼저
    // 끝난 경우), 버튼 표시도 최신 값으로 다시 맞춰준다. 아직 없으면 아무 일도
    // 하지 않는다 — createPanel이 이 시점의 bgmAutoMuteEnabled 값으로 알아서
    // 올바르게 그려준다.
    refreshBgmToggleButtonUI();
  });

  // #bgmPlayer가 이미 DOM에 있으면 바로, 아직 없으면 생기는 순간을 MutationObserver로
  // 감시해서 play 이벤트 리스너를 붙인다. setTimeout 폴링 대신 이벤트 기반으로
  // 반응해서, 재생이 시작되는 시점과 우리가 끄는 시점 사이의 지연을 최소화한다.
  function setupBgmAutoMuteWatcher() {
    const existingAudio = document.getElementById("bgmPlayer");
    if (existingAudio) {
      attachBgmPlayGuard(existingAudio);
      muteAutoplayingBgm(); // 이미 재생 중일 수 있으니 즉시 한 번 확인
      return;
    }

    const bgmObserver = new MutationObserver(function () {
      const audio = document.getElementById("bgmPlayer");
      if (audio) {
        bgmObserver.disconnect();
        attachBgmPlayGuard(audio);
        muteAutoplayingBgm();
      }
    });
    bgmObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function attachBgmPlayGuard(audioEl) {
    audioEl.addEventListener("play", function () {
      if (bgmAutoMuteEnabled) {
        muteAutoplayingBgm();
      }
    });
  }

  // 패널의 BGM 토글 버튼 표시를 현재 bgmAutoMuteEnabled 값에 맞게 다시 그린다.
  // 버튼이 아직 만들어지지 않았으면(패널 storage.get이 아직 안 끝났으면) 조용히 넘어간다.
  function refreshBgmToggleButtonUI() {
    if (bgmToggleButtonEl) {
      updateBgmToggleButtonUI(bgmToggleButtonEl, bgmAutoMuteEnabled);
    }
  }

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

  // BGM 자동 끄기 토글 버튼의 텍스트/색상을 켬/꺼짐 상태에 맞게 갱신한다.
  // 기존 .wsc-nav-button:disabled 톤(#d9d9d9 / #9aa0a6)을 그대로 재사용하되,
  // 버튼 자체는 계속 클릭 가능해야 하므로 disabled 속성이 아니라 인라인 스타일로
  // "꺼짐"을 표현한다 (content.js만 수정하면 되므로 새 CSS 클래스는 추가하지 않는다).
  //
  // 주의: bgmAutoMuteEnabled(=enabled)는 "자동으로 꺼주는 기능"이 켜져 있는지를
  // 뜻하고, 버튼 표시는 그 반대인 "결과적인 BGM 재생 상태"를 보여준다 —
  // enabled === true(자동으로 꺼주는 중) → 결과적으로 BGM은 꺼져 있으므로 "🎵 OFF".
  function updateBgmToggleButtonUI(button, enabled) {
    const bgmIsOn = !enabled;
    button.textContent = "🎵 " + (bgmIsOn ? "ON" : "OFF");
    // BGM 켜짐(ON, 초록): 기존 .wsc-nav-button 기본 스타일을 그대로 쓴다.
    // BGM 꺼짐(OFF, 회색): 이전화/다음화 버튼의 비활성(:disabled) 톤을 재사용한다.
    button.style.background = bgmIsOn ? "" : "#d9d9d9";
    button.style.color = bgmIsOn ? "" : "#9aa0a6";
  }

  // 헤더 우측의 대각선 빗금 아이콘. 순수 장식용(드래그 가능 표시)이라 클릭 핸들러는 없다.
  const DRAG_INDICATOR_ICON =
    '<svg class="wsc-drag-indicator" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">' +
    '<line x1="3" y1="13" x2="13" y2="3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></line>' +
    '<line x1="7" y1="13" x2="13" y2="7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></line>' +
    '<line x1="11" y1="13" x2="13" y2="11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></line>' +
    "</svg>";

  // ---- 플로팅 패널 생성 ----
  // 구조: #webtoon-scroll-control-panel(위치/줌 스케일 전용, overflow 없음)
  //         ├─ .wsc-panel-surface (흰 배경/모서리/그림자/overflow:hidden, 기존 header+body)
  //         └─ .wsc-help-tab / .wsc-help-panel (surface의 형제 — 왼쪽으로 잘리지 않고 펼쳐진다)
  function createPanel(initialSensitivity, initialAutoScrollSpeed, initialBgmAutoMuteEnabled) {
    const panel = document.createElement("div");
    panel.id = PANEL_ID;

    const surface = document.createElement("div");
    surface.className = "wsc-panel-surface";

    const header = document.createElement("div");
    header.className = "wsc-header";

    const headerTitle = document.createElement("span");
    headerTitle.className = "wsc-header-title";
    headerTitle.textContent = "네이버 웹툰 헬퍼";

    const dragIndicator = document.createElement("span");
    dragIndicator.innerHTML = DRAG_INDICATOR_ICON;

    header.appendChild(headerTitle);
    header.appendChild(dragIndicator);

    const body = document.createElement("div");
    body.className = "wsc-body";

    // --- 휠 감도 슬라이더 ---
    const sensitivityGroup = document.createElement("div");
    sensitivityGroup.className = "wsc-control-group";

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

    sensitivityGroup.appendChild(label);
    sensitivityGroup.appendChild(slider);
    sensitivityGroup.appendChild(valueDisplay);

    // --- 자동 스크롤 속도 슬라이더 + 상태 아이콘 (휠 감도와는 완전히 별개의 값) ---
    const autoScrollGroup = document.createElement("div");
    autoScrollGroup.className = "wsc-control-group";

    const autoScrollLabel = document.createElement("div");
    autoScrollLabel.className = "wsc-label";
    autoScrollLabel.textContent = "자동 스크롤 속도";

    const autoScrollSlider = document.createElement("input");
    autoScrollSlider.type = "range";
    autoScrollSlider.className = "wsc-slider";
    autoScrollSlider.min = String(MIN_SENSITIVITY);
    autoScrollSlider.max = String(MAX_SENSITIVITY);
    autoScrollSlider.step = String(SENSITIVITY_STEP);
    autoScrollSlider.value = String(initialAutoScrollSpeed);

    const autoScrollValueDisplay = document.createElement("div");
    autoScrollValueDisplay.className = "wsc-value";
    autoScrollValueDisplay.textContent = initialAutoScrollSpeed.toFixed(1) + "x";

    autoScrollSlider.addEventListener("input", function (event) {
      autoScrollSpeed = parseFloat(event.target.value);
      autoScrollValueDisplay.textContent = autoScrollSpeed.toFixed(1) + "x";
      chrome.storage.local.set({ [STORAGE_KEY_AUTO_SCROLL_SPEED]: autoScrollSpeed });
    });

    // 자동 스크롤 작동 상태를 아이콘으로 표시 (on/off 자체는 저장하지 않고 항상 꺼짐으로 시작)
    const autoScrollIconEl = document.createElement("div");
    autoScrollIconEl.className = "wsc-autoscroll-icon";
    autoScrollIconEl.innerHTML = AUTO_SCROLL_ICON_PAUSED;
    autoScrollIconEl.title = "자동 스크롤: 꺼짐";
    autoScrollIconEl.setAttribute("aria-label", "자동 스크롤: 꺼짐");

    autoScrollGroup.appendChild(autoScrollLabel);
    autoScrollGroup.appendChild(autoScrollSlider);
    autoScrollGroup.appendChild(autoScrollValueDisplay);
    autoScrollGroup.appendChild(autoScrollIconEl);

    // --- 이전화 / 다음화 이동 버튼 ---
    const episodeNavGroup = document.createElement("div");
    episodeNavGroup.className = "wsc-control-group wsc-episode-nav";

    const prevEpisodeButton = document.createElement("button");
    prevEpisodeButton.type = "button";
    prevEpisodeButton.className = "wsc-nav-button";
    prevEpisodeButton.id = "wsc-prev-episode";
    prevEpisodeButton.textContent = "◀ 이전화";

    const nextEpisodeButton = document.createElement("button");
    nextEpisodeButton.type = "button";
    nextEpisodeButton.className = "wsc-nav-button";
    nextEpisodeButton.id = "wsc-next-episode";
    nextEpisodeButton.textContent = "다음화 ▶";

    episodeNavGroup.appendChild(prevEpisodeButton);
    episodeNavGroup.appendChild(nextEpisodeButton);

    // --- BGM 자동 끄기 켬/꺼짐 토글 (새 회차 진입 시 앞으로 어떻게 할지에 대한 설정) ---
    const bgmToggleGroup = document.createElement("div");
    bgmToggleGroup.className = "wsc-control-group wsc-bgm-toggle";

    const bgmToggleButton = document.createElement("button");
    bgmToggleButton.type = "button";
    bgmToggleButton.className = "wsc-nav-button";
    bgmToggleButton.id = "wsc-bgm-auto-mute-toggle";
    updateBgmToggleButtonUI(bgmToggleButton, initialBgmAutoMuteEnabled);

    bgmToggleGroup.appendChild(bgmToggleButton);

    body.appendChild(sensitivityGroup);
    body.appendChild(autoScrollGroup);
    body.appendChild(episodeNavGroup);
    body.appendChild(bgmToggleGroup);

    surface.appendChild(header);
    surface.appendChild(body);
    panel.appendChild(surface);

    // --- 왼쪽 단축키 도움말 탭 + 패널 (surface의 형제라 overflow:hidden 밖에서 펼쳐진다) ---
    const HELP_TAB_CLOSED_ICON = "<";
    const HELP_TAB_OPEN_ICON = ">";

    const helpTab = document.createElement("div");
    helpTab.className = "wsc-help-tab";
    helpTab.id = "wsc-help-tab";
    helpTab.textContent = HELP_TAB_CLOSED_ICON;

    const helpPanel = document.createElement("div");
    helpPanel.className = "wsc-help-panel";
    helpPanel.id = "wsc-help-panel";
    helpPanel.hidden = true;
    // 읽기 전용 설명 텍스트만 있는 정적 콘텐츠라 innerHTML로 한 번에 채운다.
    helpPanel.innerHTML =
      '<button type="button" class="wsc-help-close" aria-label="닫기">×</button>' +
      '<div class="wsc-help-title">단축키</div>' +
      '<ul class="wsc-help-list">' +
      "<li><kbd>↑</kbd>/<kbd>↓</kbd> 자동 스크롤</li>" +
      "<li><kbd>←</kbd>/<kbd>→</kbd> 회차 이동</li>" +
      "<li><kbd>M</kbd> BGM on/off</li>" +
      "</ul>";
    const helpCloseButton = helpPanel.querySelector(".wsc-help-close");

    // 열림/닫힘 상태를 한 곳에서만 바꾼다 (hidden 속성 + 탭 아이콘을 항상 같이 갱신).
    // 탭 클릭(토글)과 닫기 버튼(항상 닫기) 둘 다 이 함수를 공유해서, 상태 갱신
    // 코드가 두 곳에 중복되지 않게 한다.
    function setHelpPanelOpen(isOpen) {
      helpPanel.hidden = !isOpen;
      helpTab.textContent = isOpen ? HELP_TAB_OPEN_ICON : HELP_TAB_CLOSED_ICON;
    }

    // 탭을 누르면 열림/닫힘을 토글한다 (바깥 클릭 시 자동 닫힘 등은 범위 밖).
    helpTab.addEventListener("click", function () {
      setHelpPanelOpen(helpPanel.hidden);
    });

    // 닫기 버튼은 무조건 닫기만 한다.
    helpCloseButton.addEventListener("click", function () {
      setHelpPanelOpen(false);
    });

    panel.appendChild(helpTab);
    panel.appendChild(helpPanel);

    document.body.appendChild(panel);

    return {
      panel,
      header,
      autoScrollIconEl,
      prevEpisodeButton,
      nextEpisodeButton,
      bgmToggleButton,
    };
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

  // ---- 이전화 / 다음화 이동 ----
  // 실제 버튼(.tool_area .link_preview / .link_next)의 onclick은 클릭 로그
  // (nclk_v2)만 남기고, 실제 이동은 페이지 자체 JS가 별도로 처리한다. href도
  // 없으므로 location.href로 이동시키는 방식은 성립하지 않고, 반드시 실제
  // 버튼을 .click()해서 네이버 자체 로직이 그대로 실행되게 해야 한다.
  const REAL_PREV_BUTTON_SELECTOR = ".tool_area .link_preview";
  const REAL_NEXT_BUTTON_SELECTOR = ".tool_area .link_next";

  // 실측 결과(1화 페이지): 이동할 회차가 없는 방향은 버튼이 DOM에서 사라지는 게
  // 아니라 disabled 속성이 붙은 채로 남아있었다 — 예)
  // <button type="button" class="link_preview" disabled ...>이전화</button>
  // 혹시 다른 페이지에서 버튼 자체가 없거나 aria-disabled를 쓰는 경우까지
  // 방어적으로 같이 확인한다.
  function isRealNavButtonUnavailable(realButton) {
    if (!realButton) return true;
    return realButton.disabled || realButton.getAttribute("aria-disabled") === "true";
  }

  function syncEpisodeNavButtonState(ourButton, selector) {
    ourButton.disabled = isRealNavButtonUnavailable(document.querySelector(selector));
  }

  function enableEpisodeNavButtons(prevButton, nextButton) {
    // 패널을 처음 만드는 시점의 실제 버튼 상태를 그대로 반영해서, 1화/최신화에서는
    // 우리 버튼도 눌러도 아무 일이 없는 게 아니라 애초에 비활성화되게 한다.
    syncEpisodeNavButtonState(prevButton, REAL_PREV_BUTTON_SELECTOR);
    syncEpisodeNavButtonState(nextButton, REAL_NEXT_BUTTON_SELECTOR);

    prevButton.addEventListener("click", function () {
      // 클릭 시점에 다시 조회한다 (그 사이 페이지가 리렌더링됐을 수 있으므로).
      const realButton = document.querySelector(REAL_PREV_BUTTON_SELECTOR);
      if (!isRealNavButtonUnavailable(realButton)) {
        realButton.click();
      }
    });

    nextButton.addEventListener("click", function () {
      const realButton = document.querySelector(REAL_NEXT_BUTTON_SELECTOR);
      if (!isRealNavButtonUnavailable(realButton)) {
        realButton.click();
      }
    });
  }

  // muteAutoplayingBgm()은 "끄기만" 하는 단방향 함수라 페이지 로드 시 자동 체크용으로
  // 그대로 남겨두고, 버튼을 눌러 설정을 바꿀 때는 현재 페이지 상태를 그 설정에 맞춰
  // 양방향으로 맞춰주는 이 함수를 대신 쓴다 (켜져 있으면 끄고, 꺼져 있으면 다시 켠다).
  function syncBgmStateWithPreference() {
    const bgmButton = document.getElementById("articleBgm");
    const bgmAudio = document.getElementById("bgmPlayer");
    if (!bgmButton) return;

    const isPlaying =
      (bgmAudio && !bgmAudio.paused) || bgmButton.getAttribute("aria-pressed") === "true";

    if (bgmAutoMuteEnabled && isPlaying) {
      bgmButton.click(); // 켜져 있으면 끈다
    } else if (!bgmAutoMuteEnabled && !isPlaying) {
      bgmButton.click(); // 꺼져 있으면 다시 켠다
    }
  }

  // BGM 자동 끄기 토글 버튼: 클릭하면 설정을 바꾸는 동시에 지금 보고 있는 페이지의
  // BGM 상태도 그 설정에 맞춰 즉시 맞춰준다.
  function enableBgmAutoMuteToggle(button) {
    button.addEventListener("click", function () {
      bgmAutoMuteEnabled = !bgmAutoMuteEnabled;
      updateBgmToggleButtonUI(button, bgmAutoMuteEnabled);
      chrome.storage.local.set({ [STORAGE_KEY_BGM_AUTO_MUTE]: bgmAutoMuteEnabled });
      syncBgmStateWithPreference();
    });
  }

  // ---- BGM 자동재생 차단 ----
  // 일부 회차는 진입 시 #bgmPlayer가 자동재생된다. audio를 직접 pause()/muted로
  // 끄면 페이지 자체 토글 버튼(#articleBgm)의 aria-pressed/아이콘 상태와 실제
  // 재생 상태가 어긋날 수 있으므로, 반드시 그 버튼을 클릭해서 페이지 자체
  // 로직으로 끈다. BGM이 없는 회차는 #articleBgm 자체가 없으므로 조용히 종료.
  function muteAutoplayingBgm() {
    const bgmButton = document.getElementById("articleBgm");
    const bgmAudio = document.getElementById("bgmPlayer");
    if (!bgmButton) return;

    const isPlaying =
      (bgmAudio && !bgmAudio.paused) || bgmButton.getAttribute("aria-pressed") === "true";

    if (isPlaying) {
      bgmButton.click();
    }
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

  // ---- 부드러운 스크롤 애니메이션 (wheel과 화살표 키가 공유) ----
  // pendingScroll: 아직 화면에 반영되지 않고 누적된 스크롤량. wheel 핸들러와
  // 화살표 키 핸들러가 같은 변수에 더하기만 하므로, 두 입력을 섞어 써도 하나의
  // requestAnimationFrame 루프가 끊김 없이 이어서 처리한다.
  let pendingScroll = 0;
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

  // ---- 마우스 휠 스크롤 감도 조절 ----
  function enableScrollControl(panel, autoScrollIconEl) {
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

        // 자동 스크롤 중에 사용자가 휠을 굴리면 즉시 멈추고, 이 휠 입력은 막지 않은 채
        // 그대로 아래 수동 스크롤(pendingScroll) 로직으로 이어서 처리한다.
        if (autoScrollDirection !== 0) {
          stopAutoScroll(autoScrollIconEl);
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

  // ---- 자동 스크롤 엔진 (wheel의 pendingScroll 루프와는 별개의 애니메이션 루프) ----
  // "프레임당 고정 픽셀" 방식은 requestAnimationFrame 호출 간격(fps)이 방향마다 달라지면
  // (예: 위로 스크롤할 때 이미지 재디코딩/리페인트 비용이 더 커서 fps가 떨어지는 경우)
  // 화면상 이동 속도도 그대로 같이 느려진다. "초당 픽셀 × 실제 경과 시간"으로 계산해서
  // fps가 오르내려도 px/sec가 항상 일정하게 유지되도록 한다.
  const AUTO_SCROLL_BASE_SPEED_PX_PER_SECOND = 90; // 1.0x 기준 초당 이동 픽셀 (기존 1.5px/frame * 60fps 상당)
  const AUTO_SCROLL_MAX_DELTA_SECONDS = 0.1; // 탭 전환 등으로 delta가 비정상적으로 커지는 것 방지

  // 외부 아이콘 폰트/이미지 없이 inline SVG만 사용 (더블 셰브론 + 일시정지 막대).
  // color는 currentColor를 참조하므로 .wsc-autoscroll-icon(.wsc-autoscroll-active)의
  // CSS color 값으로 그린/무채색 전환이 이뤄진다.
  const AUTO_SCROLL_ICON_DOWN =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 6 12 11 17 6"></polyline><polyline points="7 13 12 18 17 13"></polyline></svg>';
  const AUTO_SCROLL_ICON_UP =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="7 18 12 13 17 18"></polyline><polyline points="7 11 12 6 17 11"></polyline></svg>';
  const AUTO_SCROLL_ICON_PAUSED =
    '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"></rect><rect x="14" y="5" width="4" height="14" rx="1"></rect></svg>';

  // 자동 스크롤 상태가 바뀔 때마다 아이콘 마크업 + 강조색 클래스 + 툴팁을 갱신한다.
  function updateAutoScrollIndicator(iconEl) {
    if (!iconEl) return;

    let iconMarkup;
    let label;
    if (autoScrollDirection === 1) {
      iconMarkup = AUTO_SCROLL_ICON_DOWN;
      label = "자동 스크롤 중 (아래로)";
    } else if (autoScrollDirection === -1) {
      iconMarkup = AUTO_SCROLL_ICON_UP;
      label = "자동 스크롤 중 (위로)";
    } else {
      iconMarkup = AUTO_SCROLL_ICON_PAUSED;
      label = "자동 스크롤: 꺼짐";
    }

    iconEl.innerHTML = iconMarkup;
    iconEl.classList.toggle("wsc-autoscroll-active", autoScrollDirection !== 0);
    iconEl.title = label;
    iconEl.setAttribute("aria-label", label);
  }

  function startAutoScroll(direction, iconEl) {
    autoScrollDirection = direction;
    // 델타 타임 기준 시각을 새로 잡는다. 이전 정지 시점의 timestamp가 남아있으면
    // 그 사이 멈춰있던 시간까지 delta에 포함되어 첫 프레임에 확 튀게 된다.
    autoScrollLastTimestamp = null;
    updateAutoScrollIndicator(iconEl);

    // 이번 이동량(px/sec * deltaSeconds)의 소수점 이하를 다음 프레임으로 이월시키는
    // 누적치. window.scrollBy()에 소수점 값을 그대로 넘기면 브라우저가 정수 픽셀로
    // 반올림/버림하면서 오차가 쌓일 수 있어 wheel 쪽 pendingScroll과 같은 방식으로 처리한다.
    let pixelRemainder = 0;

    if (autoScrollFrameId === null) {
      autoScrollFrameId = requestAnimationFrame(function tick(timestamp) {
        if (autoScrollDirection === 0) {
          autoScrollFrameId = null;
          autoScrollLastTimestamp = null;
          return;
        }

        if (autoScrollLastTimestamp === null) {
          // 시작 후 첫 프레임은 기준 시각만 기록하고 이동하지 않는다 (delta 계산 불가).
          autoScrollLastTimestamp = timestamp;
          autoScrollFrameId = requestAnimationFrame(tick);
          return;
        }

        const deltaSeconds = Math.min(
          (timestamp - autoScrollLastTimestamp) / 1000,
          AUTO_SCROLL_MAX_DELTA_SECONDS
        );
        autoScrollLastTimestamp = timestamp;

        pixelRemainder +=
          AUTO_SCROLL_BASE_SPEED_PX_PER_SECOND *
          autoScrollSpeed *
          autoScrollDirection *
          deltaSeconds;

        const pixelsToMove = Math.trunc(pixelRemainder);
        pixelRemainder -= pixelsToMove;

        if (pixelsToMove !== 0) {
          const beforeY = window.scrollY;
          window.scrollBy(0, pixelsToMove);

          // 문서 최상단/최하단에 도달해서 더 이상 스크롤이 안 되면 자동으로 정지한다.
          // (이동량이 0인 프레임엔 scrollBy를 호출하지 않으므로, 그 프레임을 경계
          // 도달로 오인하지 않도록 실제로 움직인 프레임에서만 비교한다.)
          if (window.scrollY === beforeY) {
            stopAutoScroll(iconEl);
            return;
          }
        }

        autoScrollFrameId = requestAnimationFrame(tick);
      });
    }
  }

  function stopAutoScroll(iconEl) {
    autoScrollDirection = 0;
    autoScrollLastTimestamp = null;
    if (autoScrollFrameId !== null) {
      cancelAnimationFrame(autoScrollFrameId);
      autoScrollFrameId = null;
    }
    updateAutoScrollIndicator(iconEl);
  }

  // ---- 키보드 단축키 (ArrowUp/Down: 자동 스크롤 토글, ArrowLeft/Right: 이전/다음화, m: BGM 자동 끄기 토글) ----
  function enableKeyboardShortcuts(panel, autoScrollIconEl) {
    window.addEventListener("keydown", function (event) {
      const isAutoScrollKey = event.key === "ArrowUp" || event.key === "ArrowDown";
      const isEpisodeNavKey = event.key === "ArrowLeft" || event.key === "ArrowRight";
      const isBgmToggleKey = event.key.toLowerCase() === "m";

      if (!isAutoScrollKey && !isEpisodeNavKey && !isBgmToggleKey) {
        return; // 이번 범위가 아닌 키는 건드리지 않고 그대로 둔다.
      }

      // 조합키가 눌려있으면 Alt+화살표(뒤로/앞으로 가기), Shift+화살표(텍스트 선택)
      // 등 브라우저/페이지 기본 동작을 보존한다.
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
        return;
      }

      // 패널(슬라이더/버튼 등) 내부에 포커스가 있으면 그 요소의 네이티브 키 동작
      // (슬라이더 값 조절, 버튼 Enter/Space 등)이 그대로 동작해야 하므로 건드리지 않는다.
      if (panel.contains(event.target)) {
        return;
      }

      // 텍스트 입력 중인 요소(검색창, 댓글 입력창 등)에서는 입력을 방해하지 않는다.
      const activeElement = document.activeElement;
      const isTextInputFocused =
        activeElement &&
        (activeElement.tagName === "INPUT" ||
          activeElement.tagName === "TEXTAREA" ||
          activeElement.tagName === "SELECT" ||
          activeElement.isContentEditable);
      if (isTextInputFocused) {
        return;
      }

      // ArrowLeft/ArrowRight -> 패널의 이전화/다음화 버튼을 그대로 클릭한다.
      // (실제 네이버 버튼 재조회, disabled 처리 등은 그 버튼의 기존 클릭 핸들러가 담당)
      if (isEpisodeNavKey) {
        event.preventDefault();
        if (event.repeat) return; // 길게 눌러도 여러 화를 건너뛰지 않게
        const button =
          event.key === "ArrowLeft"
            ? document.getElementById("wsc-prev-episode")
            : document.getElementById("wsc-next-episode");
        if (button) button.click();
        return;
      }

      // m -> 패널의 BGM 자동 끄기 토글 버튼을 그대로 클릭한다.
      // 문자 키라 브라우저 기본 동작을 막을 필요가 없어 preventDefault는 호출하지 않는다.
      if (isBgmToggleKey) {
        if (event.repeat) return;
        const bgmToggleButton = document.getElementById("wsc-bgm-auto-mute-toggle");
        if (bgmToggleButton) bgmToggleButton.click();
        return;
      }

      // ArrowUp/ArrowDown -> 자동 스크롤 토글 (기존 로직 그대로)
      // 브라우저 기본 스크롤은 항상 막는다 (키를 누르고 있는 동안의 반복 이벤트에도 매번).
      event.preventDefault();

      // 토글 판정은 "새로 눌린 시점"에만 한 번 실행한다. OS 자동 반복(길게 누름)은 무시.
      if (event.repeat) {
        return;
      }

      const pressedDirection = event.key === "ArrowDown" ? 1 : -1;

      if (autoScrollDirection === pressedDirection) {
        // 같은 방향키를 다시 누름 -> 정지
        stopAutoScroll(autoScrollIconEl);
      } else if (autoScrollDirection === 0) {
        // 정지 상태에서 처음 누름 -> 해당 방향으로 시작
        startAutoScroll(pressedDirection, autoScrollIconEl);
      } else {
        // 반대 방향으로 작동 중일 때 다른 화살표를 누름 -> 정지만 시킨다 (바로 전환하지 않음)
        stopAutoScroll(autoScrollIconEl);
      }
    });
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
  // 저장된 감도/패널 위치/BGM 자동 끄기 설정을 먼저 불러온 뒤 그 값을 기준으로 UI를 생성한다.
  chrome.storage.local.get(
    [
      STORAGE_KEY_SENSITIVITY,
      STORAGE_KEY_PANEL_POSITION,
      STORAGE_KEY_AUTO_SCROLL_SPEED,
      STORAGE_KEY_BGM_AUTO_MUTE,
    ],
    function (stored) {
      sensitivity = clampSensitivity(stored[STORAGE_KEY_SENSITIVITY]);
      autoScrollSpeed = clampSensitivity(stored[STORAGE_KEY_AUTO_SCROLL_SPEED]);
      // BGM 자동 끄기 설정 자체는 파일 상단의 독립적인 storage.get이 이미 최대한
      // 빨리 불러와서 감시를 시작했을 수 있다. 여기서는 패널 생성용으로 다시 한 번
      // 같은 값을 읽어 초기 버튼 표시에 쓴다 (두 콜백 모두 같은 storage 키를 읽으므로
      // 최종적으로는 같은 값으로 수렴한다).
      bgmAutoMuteEnabled =
        typeof stored[STORAGE_KEY_BGM_AUTO_MUTE] === "boolean"
          ? stored[STORAGE_KEY_BGM_AUTO_MUTE]
          : true;

      const {
        panel,
        header,
        autoScrollIconEl,
        prevEpisodeButton,
        nextEpisodeButton,
        bgmToggleButton,
      } = createPanel(sensitivity, autoScrollSpeed, bgmAutoMuteEnabled);
      currentPanel = panel;
      bgmToggleButtonEl = bgmToggleButton; // 독립 storage.get 콜백이 나중에 끝나도 버튼을 찾을 수 있게

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
      enableScrollControl(panel, autoScrollIconEl);
      enableKeyboardShortcuts(panel, autoScrollIconEl);
      enableEpisodeNavButtons(prevEpisodeButton, nextEpisodeButton);
      enableBgmAutoMuteToggle(bgmToggleButton);
    }
  );
})();

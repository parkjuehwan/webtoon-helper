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

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

  let sensitivity = DEFAULT_SENSITIVITY;
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
  function createPanel(initialSensitivity, initialAutoScrollSpeed) {
    const panel = document.createElement("div");
    panel.id = PANEL_ID;

    const header = document.createElement("div");
    header.className = "wsc-header";
    header.textContent = "네이버 웹툰 헬퍼";

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

    body.appendChild(sensitivityGroup);
    body.appendChild(autoScrollGroup);

    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);

    return { panel, header, autoScrollIconEl };
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

  // ---- 화살표 키(ArrowUp / ArrowDown) 자동 스크롤 토글 ----
  function enableArrowKeyAutoScroll(panel, autoScrollIconEl) {
    window.addEventListener("keydown", function (event) {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") {
        return; // 이번 범위가 아닌 키는 건드리지 않고 그대로 둔다.
      }

      // 조합키가 눌려있으면 Alt+화살표(뒤로/앞으로 가기), Shift+화살표(텍스트 선택)
      // 등 브라우저/페이지 기본 동작을 보존한다.
      if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
        return;
      }

      // 패널(슬라이더 등) 내부에서는 네이티브 화살표 키 동작(슬라이더 값 조절)이
      // 그대로 동작해야 하므로 건드리지 않는다.
      if (panel.contains(event.target)) {
        return;
      }

      // 텍스트 입력 중인 요소(검색창, 댓글 입력창 등)에서는 커서 이동을 방해하지 않는다.
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
  // 저장된 감도/패널 위치를 먼저 불러온 뒤 그 값을 기준으로 UI를 생성한다.
  chrome.storage.local.get(
    [STORAGE_KEY_SENSITIVITY, STORAGE_KEY_PANEL_POSITION, STORAGE_KEY_AUTO_SCROLL_SPEED],
    function (stored) {
      sensitivity = clampSensitivity(stored[STORAGE_KEY_SENSITIVITY]);
      autoScrollSpeed = clampSensitivity(stored[STORAGE_KEY_AUTO_SCROLL_SPEED]);

      const { panel, header, autoScrollIconEl } = createPanel(sensitivity, autoScrollSpeed);
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
      enableScrollControl(panel, autoScrollIconEl);
      enableArrowKeyAutoScroll(panel, autoScrollIconEl);
    }
  );
})();

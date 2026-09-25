/* Kazakhstan IELTS — live schedule, read from the teacher's Google Sheet.
   An empty "Student" cell = free slot. Student names are never shown on the page. */
(function () {
  "use strict";

  var SHEET_ID = "1WoFefW8smt_CmdoSOpJRm09RQt70BKvY";
  var CSV_URL = "https://docs.google.com/spreadsheets/d/" + SHEET_ID + "/export?format=csv";
  var QUERY_URL = "https://docs.google.com/spreadsheets/d/" + SHEET_ID + "/gviz/tq?tqx=out:json";
  var WHATSAPP = "77081726414";
  var REFRESH_MS = 5 * 60 * 1000;
  var DAY_NAMES = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  var TIME_RE = /(\d{1,2}):(\d{2})\s*[–—-]\s*(\d{1,2}):(\d{2})/;

  var state = { data: null, day: todayIndex(), selected: {}, status: "loading" };

  function t(key) {
    return (window.i18n && window.i18n.get("schedule." + key)) || "";
  }

  function todayIndex() {
    try {
      var wd = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Almaty", weekday: "long" }).format(new Date());
      var i = DAY_NAMES.indexOf(wd.toLowerCase());
      if (i >= 0) return i;
    } catch (e) {}
    return (new Date().getDay() + 6) % 7;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function parseCSV(text) {
    var rows = [], row = [], cell = "", q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
        } else cell += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += c;
    }
    row.push(cell); rows.push(row);
    return rows;
  }

  function pad(n) { return (n < 10 ? "0" : "") + n; }

  // Finds the day header row ("Monday", "Tuesday", ...) and every "7:00 – 7:30" row
  // below it, so rows/columns can be moved in the sheet without breaking the page.
  function parseSchedule(rows) {
    var headerIdx = -1, dayCols = [];
    for (var r = 0; r < rows.length && headerIdx < 0; r++) {
      var cols = DAY_NAMES.map(function (d) {
        for (var c = 0; c < rows[r].length; c++) {
          if (rows[r][c].trim().toLowerCase() === d) return c;
        }
        return -1;
      });
      if (cols.every(function (c) { return c >= 0; })) { headerIdx = r; dayCols = cols; }
    }
    if (headerIdx < 0) throw new Error("Day header row not found");

    var slots = [], busy = DAY_NAMES.map(function () { return []; });
    for (r = headerIdx + 1; r < rows.length; r++) {
      var m = TIME_RE.exec(rows[r][0] || "");
      if (!m) continue;
      var sh = +m[1], sm = +m[2], eh = +m[3], em = +m[4];
      slots.push({
        start: sh * 60 + sm,
        end: eh * 60 + em,
        label: pad(sh) + ":" + pad(sm),
        endLabel: pad(eh) + ":" + pad(em)
      });
      for (var d = 0; d < 7; d++) {
        busy[d].push(((rows[r][dayCols[d]] || "").trim()) !== "");
      }
    }
    if (!slots.length) throw new Error("No time rows found");
    return { slots: slots, busy: busy };
  }

  // Primary source: the Sheets query endpoint loaded as a <script> (JSONP). Unlike fetch(),
  // this needs no CORS, so it also works when the page is opened as a local file.
  function loadViaScript() {
    return new Promise(function (resolve, reject) {
      var cb = "__kzSched" + Date.now();
      var script = document.createElement("script");
      var timer = setTimeout(function () { cleanup(); reject(new Error("timeout")); }, 15000);
      function cleanup() {
        clearTimeout(timer);
        delete window[cb];
        script.remove();
      }
      window[cb] = function (res) {
        cleanup();
        if (!res || res.status === "error" || !res.table) return reject(new Error("query error"));
        resolve(res.table.rows.map(function (row) {
          return (row.c || []).map(function (c) {
            if (!c || c.v == null) return "";
            return String(c.f != null ? c.f : c.v);
          });
        }));
      };
      script.onerror = function () { cleanup(); reject(new Error("script error")); };
      script.src = QUERY_URL + ";responseHandler:" + cb + "&headers=0&t=" + Date.now();
      document.head.appendChild(script);
    });
  }

  function loadViaCSV() {
    return fetch(CSV_URL + "&t=" + Date.now(), { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(parseCSV);
  }

  function load() {
    loadViaScript()
      .then(parseSchedule)
      .catch(function () { return loadViaCSV().then(parseSchedule); })
      .then(function (data) {
        state.data = data;
        state.status = "ready";
        // Drop selections that have since been booked.
        Object.keys(state.selected).forEach(function (k) {
          var p = k.split("|");
          if (state.data.busy[+p[0]][+p[1]] !== false) delete state.selected[k];
        });
        render();
      })
      .catch(function () {
        if (!state.data) { state.status = "error"; render(); }
      });
  }

  function freeCount(d) {
    return state.data.busy[d].filter(function (b) { return !b; }).length;
  }

  function slotMinutes() {
    var s = state.data.slots[0];
    return s.end - s.start;
  }

  function fmtHours(n) {
    var h = (n * slotMinutes()) / 60;
    return (Math.round(h * 10) / 10).toString();
  }

  // Merges consecutive selected slots into ranges, e.g. 12:00–13:00.
  function selectedRanges() {
    var out = [];
    for (var d = 0; d < 7; d++) {
      var idx = [];
      state.data.slots.forEach(function (_, i) { if (state.selected[d + "|" + i]) idx.push(i); });
      var ranges = [];
      idx.forEach(function (i) {
        var last = ranges[ranges.length - 1];
        if (last && last.to === i - 1 && state.data.slots[i - 1].end === state.data.slots[i].start) last.to = i;
        else ranges.push({ from: i, to: i });
      });
      ranges.forEach(function (rg) {
        out.push({ day: d, text: state.data.slots[rg.from].label + "–" + state.data.slots[rg.to].endLabel });
      });
    }
    return out;
  }

  function el(id) { return document.getElementById(id); }

  function renderTabs() {
    var days = t("days_short") || [];
    el("sched-tabs").innerHTML = DAY_NAMES.map(function (_, d) {
      var active = d === state.day;
      var n = freeCount(d);
      var isToday = d === todayIndex();
      return '<button type="button" role="tab" aria-selected="' + active + '" data-day="' + d + '" class="snap-start flex-shrink-0 min-w-[4.75rem] sm:min-w-0 sm:flex-1 rounded-2xl border px-3 py-2.5 text-center transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ' +
        (active ? "bg-brand-600 border-brand-600 text-white shadow-soft" : "bg-white border-slate-200 text-slate-700 hover:border-brand-300 hover:bg-brand-50") + '">' +
        '<span class="block text-sm font-bold">' + esc(days[d] || "") + (isToday ? ' <span class="inline-block w-1.5 h-1.5 rounded-full align-middle ' + (active ? "bg-white" : "bg-accent-500") + '"></span>' : "") + "</span>" +
        '<span class="block text-[11px] mt-0.5 ' + (active ? "text-brand-100" : n ? "text-emerald-600 font-semibold" : "text-slate-400") + '">' +
        fmtHours(n) + " " + esc(t("free_hours")) + "</span></button>";
    }).join("");
    var tabs = el("sched-tabs"), active = tabs.querySelector('[aria-selected="true"]');
    if (active && tabs.scrollWidth > tabs.clientWidth) {
      tabs.scrollLeft = active.offsetLeft - tabs.offsetLeft - (tabs.clientWidth - active.offsetWidth) / 2;
    }
  }

  function renderDay() {
    var d = state.day;
    var slots = state.data.slots;
    var dayNames = t("days") || [];
    el("sched-day-title").textContent = dayNames[d] || "";
    el("sched-day-count").textContent = fmtHours(freeCount(d)) + " " + t("free_hours");

    var parts = [
      { key: "part_morning", icon: "🌅", test: function (s) { return s.start < 12 * 60; } },
      { key: "part_afternoon", icon: "☀️", test: function (s) { return s.start >= 12 * 60 && s.start < 17 * 60; } },
      { key: "part_evening", icon: "🌙", test: function (s) { return s.start >= 17 * 60; } }
    ];

    var html = "";
    if (!freeCount(d)) {
      html += '<div class="rounded-2xl bg-amber-50 border border-amber-100 text-amber-800 text-sm px-4 py-3 mb-6">' + esc(t("no_free")) + "</div>";
    }
    parts.forEach(function (p) {
      var items = [];
      slots.forEach(function (s, i) { if (p.test(s)) items.push(i); });
      if (!items.length) return;
      var free = items.filter(function (i) { return !state.data.busy[d][i]; }).length;
      html += '<div class="mb-6 last:mb-0"><div class="flex items-center justify-between mb-3">' +
        '<h4 class="text-xs font-bold uppercase tracking-wider text-slate-500">' + p.icon + " " + esc(t(p.key)) + "</h4>" +
        '<span class="text-xs text-slate-400">' + free + "/" + items.length + " " + esc(t("free_count")) + "</span></div>" +
        '<div class="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-2">';
      items.forEach(function (i) {
        var s = slots[i];
        var time = esc(s.label) + '<span class="opacity-60"> – ' + esc(s.endLabel) + "</span>";
        if (state.data.busy[d][i]) {
          html += '<div class="slot-busy rounded-xl px-1.5 py-2.5 text-center text-[12px] sm:text-sm whitespace-nowrap tabular-nums text-slate-400 line-through" aria-label="' + esc(s.label + " " + t("legend_busy")) + '">' + time + "</div>";
        } else {
          var sel = !!state.selected[d + "|" + i];
          html += '<button type="button" data-slot="' + i + '" aria-pressed="' + sel + '" class="rounded-xl px-1.5 py-2.5 text-center text-[12px] sm:text-sm whitespace-nowrap tabular-nums font-semibold border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ' +
            (sel ? "bg-brand-600 border-brand-600 text-white shadow-soft" : "bg-emerald-50 border-emerald-200 text-emerald-800 hover:bg-emerald-100 hover:border-emerald-300") + '">' + time + "</button>";
        }
      });
      html += "</div></div>";
    });
    el("sched-day-slots").innerHTML = html;
  }

  function renderOverview() {
    var days = t("days_short") || [];
    var slots = state.data.slots;
    var html = '<div class="grid gap-[3px]" style="grid-template-columns: 2.6rem repeat(7, minmax(0, 1fr))"><div></div>';
    DAY_NAMES.forEach(function (_, d) {
      html += '<button type="button" data-day="' + d + '" class="text-[10px] font-bold pb-1 rounded ' + (d === state.day ? "text-brand-700" : "text-slate-400 hover:text-brand-600") + '">' + esc(days[d] || "") + "</button>";
    });
    slots.forEach(function (s, i) {
      var onHour = s.start % 60 === 0;
      html += '<div class="text-[10px] leading-3 text-slate-400 text-right pr-1.5">' + (onHour ? esc(s.label) : "") + "</div>";
      DAY_NAMES.forEach(function (_, d) {
        var busy = state.data.busy[d][i];
        var sel = state.selected[d + "|" + i];
        var cls = sel ? "bg-brand-600" : busy ? "bg-slate-200" : "bg-emerald-400/80 hover:bg-emerald-500";
        html += '<button type="button" tabindex="-1" data-day="' + d + '" title="' + esc((t("days") || [])[d] + " " + s.label + " — " + t(busy ? "legend_busy" : "legend_free")) + '" class="h-3 rounded-[3px] ' + cls + '"></button>';
      });
    });
    html += "</div>";
    el("sched-overview").innerHTML = html;
  }

  function renderBar() {
    var ranges = selectedRanges();
    var days = t("days_short") || [];
    var chips = el("sched-selected");
    var btn = el("sched-book");
    el("sched-clear").classList.toggle("hidden", !ranges.length);
    if (!ranges.length) {
      chips.innerHTML = '<span class="text-sm text-slate-400">' + esc(t("selected_none")) + "</span>";
      btn.setAttribute("aria-disabled", "true");
      btn.classList.add("opacity-50", "pointer-events-none");
      btn.href = "#";
      return;
    }
    chips.innerHTML = ranges.map(function (r) {
      return '<span class="inline-flex items-center rounded-full bg-brand-50 text-brand-700 text-xs font-semibold px-2.5 py-1">' + esc(days[r.day] + " " + r.text) + "</span>";
    }).join("");
    var full = t("days") || [];
    var msg = t("wa_intro") + "\n" + ranges.map(function (r) { return "• " + full[r.day] + ": " + r.text; }).join("\n");
    btn.href = "https://wa.me/" + WHATSAPP + "?text=" + encodeURIComponent(msg);
    btn.removeAttribute("aria-disabled");
    btn.classList.remove("opacity-50", "pointer-events-none");
  }

  function render() {
    el("sched-loading").classList.toggle("hidden", state.status !== "loading");
    el("sched-error").classList.toggle("hidden", state.status !== "error");
    el("sched-app").classList.toggle("hidden", state.status !== "ready");
    if (state.status !== "ready") return;
    renderTabs();
    renderDay();
    renderOverview();
    renderBar();
  }

  function setDay(d) {
    state.day = d;
    render();
  }

  document.addEventListener("DOMContentLoaded", function () {
    document.addEventListener("click", function (e) {
      var dayBtn = e.target.closest("[data-day]");
      if (dayBtn && dayBtn.closest("#sched-app")) {
        setDay(+dayBtn.getAttribute("data-day"));
        if (dayBtn.closest("#sched-overview")) {
          el("sched-day-panel").scrollIntoView({ behavior: "smooth", block: "start" });
        }
        return;
      }
      var slotBtn = e.target.closest("[data-slot]");
      if (slotBtn) {
        var key = state.day + "|" + slotBtn.getAttribute("data-slot");
        if (state.selected[key]) delete state.selected[key]; else state.selected[key] = true;
        render();
      }
    });
    el("sched-clear").addEventListener("click", function () { state.selected = {}; render(); });
    el("sched-retry").addEventListener("click", function () { state.status = "loading"; render(); load(); });

    load();
    setInterval(load, REFRESH_MS);
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") load();
    });
  });

  window.onLanguageChange = function () { render(); };
})();

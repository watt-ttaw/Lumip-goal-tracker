import "./style.css"
import { auth, db, isFirebaseConfigured } from "./firebase.js"
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
} from "firebase/auth"
import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  addDoc,
  collection,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  arrayUnion,
} from "firebase/firestore"

const root = document.getElementById("app")

// Streak values that trigger a LUMIP milestone celebration.
const MILESTONES = [10, 50, 100, 200, 300, 365, 400, 500, 600, 700, 800, 900, 1000]

// Shared LUMIP brand lockup: the requested fire emoji + wordmark.
const brandMarkup = `
  <div class="brand">
    <span class="brand-mark" aria-hidden="true">🔥</span>
    <span class="brand-name">LUMIP</span>
  </div>
`

const themeToggleMarkup = `<button class="theme-toggle" type="button" data-theme-toggle aria-label="Switch to light mode"><span data-theme-icon>☼</span><span data-theme-label>Light</span></button>`

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme
  document.querySelectorAll("[data-theme-toggle]").forEach((button) => {
    const light = theme === "light"
    button.setAttribute("aria-label", light ? "Switch to dark mode" : "Switch to light mode")
    button.querySelector("[data-theme-icon]").textContent = light ? "☾" : "☼"
    button.querySelector("[data-theme-label]").textContent = light ? "Dark" : "Light"
  })
}

function bindThemeToggle(scope) {
  scope.querySelector("[data-theme-toggle]")?.addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light")
  })
  applyTheme(document.documentElement.dataset.theme || "dark")
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const el = (html) => {
  const t = document.createElement("template")
  t.innerHTML = html.trim()
  return t.content.firstElementChild
}

// Local YYYY-MM-DD key for streak math.
const dayKey = (d = new Date()) => {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`
}

// Local YYYY-MM key, used to know when a fresh batch of Streak Freezes is due.
const monthKey = (d = new Date()) => `${d.getFullYear()}-${d.getMonth()}`

// Streak Freezes granted at the start of every calendar month.
const FREEZES_PER_MONTH = 5

// Given a user doc's raw data, returns the freeze count/month that should be
// in effect *right now* — without writing anything. Callers persist it when
// they have a reason to (an update already in flight, or an explicit sync).
function currentFreezeState(data = {}) {
  const thisMonth = monthKey()
  if (data.freezesMonth !== thisMonth) {
    return { freezes: FREEZES_PER_MONTH, freezesMonth: thisMonth, isNewMonth: true }
  }
  return {
    freezes: typeof data.freezes === "number" ? data.freezes : FREEZES_PER_MONTH,
    freezesMonth: thisMonth,
    isNewMonth: false,
  }
}

// Makes sure a new month's Streak Freeze allotment is persisted even if the
// user hasn't completed a goal yet today (bumpStreak only runs on completion).
async function ensureMonthlyFreezes(uid) {
  const userRef = doc(db, "users", uid)
  const snap = await getDoc(userRef)
  if (!snap.exists()) return
  const { freezes, freezesMonth, isNewMonth } = currentFreezeState(snap.data())
  if (isNewMonth) {
    await updateDoc(userRef, { freezes, freezesMonth })
  }
}

const daysBetween = (a, b) => {
  const ms = 24 * 60 * 60 * 1000
  const da = new Date(a)
  da.setHours(0, 0, 0, 0)
  const dbb = new Date(b)
  dbb.setHours(0, 0, 0, 0)
  return Math.round((dbb - da) / ms)
}

const withTimeout = (promise, ms = 4500) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error("Firebase timed out"), { code: "app/offline-timeout" })), ms),
    ),
  ])

const authErrorMessage = (code) => {
  const map = {
    "auth/invalid-email": "That email address looks invalid.",
    "auth/missing-password": "Please enter a password.",
    "auth/weak-password": "Password should be at least 6 characters.",
    "auth/email-already-in-use": "An account already exists for that email.",
    "auth/invalid-credential": "Invalid email or password",
    "auth/user-not-found": "Account not found, sign up",
    "auth/wrong-password": "Invalid email or password",
    "auth/too-many-requests": "Too many attempts. Try again later.",
    "auth/network-request-failed": "You appear to be offline. Check your connection and try again.",
    "app/offline-timeout": "Firebase is taking too long to respond. Check your connection and try again.",
  }
  return map[code] || "Something went wrong. Please try again."
}

// ---------------------------------------------------------------------------
// Not-configured screen
// ---------------------------------------------------------------------------
function renderSetup() {
  root.innerHTML = ""
  const screen = el(`
    <div class="screen">
      <div class="center">
        <div class="card">
          ${brandMarkup}
          <h1>Almost there</h1>
          <p class="sub">Connect your Firebase project to get started.</p>
          <div class="notice">
            Open <code>src/firebase.js</code> and replace the placeholder
            <code>firebaseConfig</code> values with the ones from your Firebase
            web app. Then enable <strong>Email/Password</strong> auth and create
            a <strong>Firestore</strong> database in the Firebase console.
          </div>
        </div>
      </div>
    </div>
  `)
  root.appendChild(screen)
}

// ---------------------------------------------------------------------------
// Auth screen (login / signup)
// ---------------------------------------------------------------------------
function renderAuth() {
  let mode = "login" // or "signup"
  root.innerHTML = ""

  const screen = el(`
    <div class="screen">
      <div class="center">
        <div class="card">
          <div class="auth-topline">${brandMarkup}${themeToggleMarkup}</div>
          <h1 data-title>Welcome back</h1>
          <p class="sub" data-sub>Log in to keep your streak going.</p>
          <div class="error" data-error hidden></div>
          <form data-form>
            <div class="field nickname-field" data-nickname-field hidden>
              <label for="nickname">Nickname</label>
              <input id="nickname" type="text" autocomplete="nickname" maxlength="32" placeholder="How should we call you?" />
            </div>
            <div class="field">
              <label for="email">Email</label>
              <input id="email" type="email" autocomplete="email" required />
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input id="password" type="password" autocomplete="current-password" required />
            </div>
            <div class="field confirm-password-field" data-confirm-field hidden>
              <label for="confirm-password">Confirm password</label>
              <input id="confirm-password" type="password" autocomplete="new-password" />
            </div>
            <button class="btn" type="submit" data-submit>Log in</button>
          </form>
          <p class="switch-line">
            <span data-switch-text>New here?</span>
            <button type="button" data-switch>Create an account</button>
          </p>
        </div>
      </div>
    </div>
  `)

  const title = screen.querySelector("[data-title]")
  const sub = screen.querySelector("[data-sub]")
  const errorBox = screen.querySelector("[data-error]")
  const form = screen.querySelector("[data-form]")
  const submitBtn = screen.querySelector("[data-submit]")
  const nicknameField = screen.querySelector("[data-nickname-field]")
  const nicknameInput = screen.querySelector("#nickname")
  const confirmField = screen.querySelector("[data-confirm-field]")
  const confirmPassword = screen.querySelector("#confirm-password")
  const switchText = screen.querySelector("[data-switch-text]")
  const switchBtn = screen.querySelector("[data-switch]")

  const showError = (msg) => {
    errorBox.textContent = msg
    errorBox.hidden = false
  }

  const setMode = (m) => {
    mode = m
    errorBox.hidden = true
    nicknameField.hidden = m !== "signup"
    nicknameInput.required = m === "signup"
    confirmField.hidden = m !== "signup"
    confirmPassword.required = m === "signup"
    nicknameInput.value = ""
    confirmPassword.value = ""
    if (m === "login") {
      title.textContent = "Welcome back"
      sub.textContent = "Log in to keep your streak going."
      submitBtn.textContent = "Log in"
      switchText.textContent = "New here?"
      switchBtn.textContent = "Create an account"
    } else {
      title.textContent = "Create account"
      sub.textContent = "Start building your daily streak today."
      submitBtn.textContent = "Sign up"
      switchText.textContent = "Already have an account?"
      switchBtn.textContent = "Log in"
    }
  }

  switchBtn.addEventListener("click", () =>
    setMode(mode === "login" ? "signup" : "login"),
  )

  form.addEventListener("submit", async (e) => {
    e.preventDefault()
    errorBox.hidden = true
    const email = form.email.value.trim()
    const password = form.password.value
    const nickname = nicknameInput.value.trim()
    if (mode === "signup" && password !== confirmPassword.value) {
      showError("password must match")
      confirmPassword.focus()
      return
    }
    submitBtn.disabled = true
    submitBtn.textContent = mode === "login" ? "Logging in…" : "Creating…"
    try {
      if (mode === "login") {
        await withTimeout(signInWithEmailAndPassword(auth, email, password))
      } else {
        const credential = await withTimeout(createUserWithEmailAndPassword(auth, email, password))
        await withTimeout(setDoc(doc(db, "users", credential.user.uid), {
          nickname,
          createdAt: serverTimestamp(),
        }, { merge: true }))
        // Switch the visible form before signing out so the auth listener cannot
        // leave the user on a stale signup screen during the transition.
        setMode("login")
        form.reset()
        submitBtn.disabled = false
        showError("Account created. Log in to continue.")
        await withTimeout(signOut(auth))
      }
      // onAuthStateChanged renders the dashboard after login.
    } catch (err) {
      showError(authErrorMessage(err.code))
      submitBtn.disabled = false
      setMode(mode)
    }
  })

  bindThemeToggle(screen)
  root.appendChild(screen)
}

// ---------------------------------------------------------------------------
// Streak handling (users/{uid} doc)
// ---------------------------------------------------------------------------
// Returns { streak, freezeUsed }. freezeUsed is true when a single missed
// day was covered by spending a Streak Freeze instead of resetting the streak.
async function bumpStreak(uid) {
  const userRef = doc(db, "users", uid)
  const snap = await getDoc(userRef)
  const today = dayKey()
  const now = new Date()

  if (!snap.exists()) {
    await setDoc(userRef, {
      streak: 1,
      lastActiveKey: today,
      lastActiveAt: serverTimestamp(),
      completionDates: [today],
      freezes: FREEZES_PER_MONTH,
      freezesMonth: monthKey(),
    })
    return { streak: 1, freezeUsed: false }
  }

  const data = snap.data()
  const { freezes: carriedFreezes, freezesMonth } = currentFreezeState(data)

  if (data.lastActiveKey === today) {
    // Already counted today — but still land a monthly freeze reset if one is due,
    // so the counter is correct even without a fresh completion.
    if (freezesMonth !== data.freezesMonth) {
      await updateDoc(userRef, { freezes: carriedFreezes, freezesMonth })
    }
    return { streak: data.streak || 0, freezeUsed: false }
  }

  let streak = data.streak || 0
  let freezes = carriedFreezes
  let freezeUsed = false

  const gap = data.lastActiveAt?.toDate
    ? daysBetween(data.lastActiveAt.toDate(), now)
    : null

  if (gap === 1) {
    streak += 1 // consecutive day
  } else if (gap === 2 && freezes > 0) {
    // Exactly one day was missed and a Streak Freeze is available — spend one
    // to keep the streak alive instead of resetting it.
    freezes -= 1
    freezeUsed = true
    streak += 1
  } else {
    streak = 1 // reset (missed 2+ days, or no freeze left, or first completion)
  }

  const update = {
    streak,
    lastActiveKey: today,
    lastActiveAt: serverTimestamp(),
    freezes,
    freezesMonth,
    completionDates: arrayUnion(today),
  }
  if (freezeUsed) update.freezeLog = arrayUnion(today)

  await updateDoc(userRef, update)
  return { streak, freezeUsed }
}

// Watches the user doc and reports both the streak and the live freeze count
// (computed locally via currentFreezeState so the UI is correct even in the
// moment before a new month's reset has been persisted).
function watchUser(uid, onChange, onError) {
  return onSnapshot(
    doc(db, "users", uid),
    (snap) => {
      if (!snap.exists()) {
        onChange({ streak: 0, freezes: FREEZES_PER_MONTH })
        return
      }
      const data = snap.data()
      const { freezes } = currentFreezeState(data)
      onChange({ streak: data.streak || 0, freezes })
    },
    (err) => {
      onError?.(err)
    },
  )
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
async function renderDashboard(user) {
  // Render immediately; profile data is enhancement-only and must never block the UI.
  let nickname = user.email
  root.innerHTML = ""
  let unsubGoals = null
  let unsubStreak = null

  const screen = el(`
    <div class="screen">
      <header class="topbar">
        <div class="topbar-inner">
          ${brandMarkup}
          <div class="topbar-actions">
            ${themeToggleMarkup}
            <div class="user-actions">
              <span class="user-email">${escapeHtml(nickname)}</span>
              <button class="btn ghost" data-logout>Log out</button>
            </div>
          </div>
        </div>
      </header>
      <main class="container">
        <section class="streak" aria-live="polite">
          <span class="streak-mark" aria-hidden="true">🔥</span>
          <div>
            <div class="count" data-streak>0 Days</div>
            <div class="label">Current streak &middot; complete a goal to keep it alive</div>
          </div>
          <div class="freeze-counter" data-freeze-counter title="Streak Freezes save your streak if you miss a day. You get 5 every month.">
            <span class="freeze-icon" aria-hidden="true">❄️</span>
            <span data-freeze-count>${FREEZES_PER_MONTH}</span>
            <span class="freeze-label">Freezes</span>
          </div>
        </section>

        <form class="add-row" data-add-form>
          <input type="text" data-add-input placeholder="Add a new daily goal…" aria-label="New goal" required />
          <button class="btn" type="submit">Add goal</button>
        </form>

        <h2 class="section-title">Today's goals</h2>
        <ul class="goal-list" data-list></ul>
        <div class="loading" data-loading>Loading your goals…</div>
      </main>
    </div>
  `)

  const streakEl = screen.querySelector("[data-streak]")
  const freezeCountEl = screen.querySelector("[data-freeze-count]")
  const addForm = screen.querySelector("[data-add-form]")
  const addInput = screen.querySelector("[data-add-input]")
  const list = screen.querySelector("[data-list]")
  const loading = screen.querySelector("[data-loading]")

  screen.querySelector("[data-logout]").addEventListener("click", () => {
    if (unsubGoals) unsubGoals()
    if (unsubStreak) unsubStreak()
    signOut(auth)
  })

  // Make sure a new month's Streak Freeze allotment shows up even before the
  // user completes anything today.
  ensureMonthlyFreezes(user.uid).catch(() => {
    // Offline or blocked — the local fallback in watchUser still renders a value.
  })

  // Streak + freeze listener
  unsubStreak = watchUser(user.uid, ({ streak, freezes }) => {
    streakEl.textContent = `${streak} ${streak === 1 ? "Day" : "Days"}`
    freezeCountEl.textContent = freezes
  }, () => {
    streakEl.textContent = "— Days"
  })

  // Add a goal
  const goalsCol = collection(db, "users", user.uid, "goals")
  addForm.addEventListener("submit", async (e) => {
    e.preventDefault()
    const title = addInput.value.trim()
    if (!title) return
    addInput.value = ""
    await addDoc(goalsCol, {
      title,
      done: false,
      note: "",
      createdAt: serverTimestamp(),
    })
  })

  // Keep the latest goal states so we can detect "all goals done".
  let latestGoals = []

  // Called after a goal is checked off and the streak has been bumped.
  const onGoalChecked = (newStreak, checkedId, freezeUsed) => {
    if (freezeUsed) showFreezeToast()
    const allDone =
      latestGoals.length > 0 &&
      latestGoals.every((g) => (g.id === checkedId ? true : g.done))
    if (allDone && MILESTONES.includes(newStreak)) {
      showMilestone(newStreak, user.email)
    }
  }

  // Live goals list
  const q = query(goalsCol, orderBy("createdAt", "asc"))
  // Profile loading is intentionally separate from initial render.
  withTimeout(getDoc(doc(db, "users", user.uid)))
    .then((profileSnap) => {
      const savedNickname = profileSnap.exists() && profileSnap.data().nickname
      if (savedNickname && root.contains(screen)) {
        screen.querySelector(".user-email").textContent = savedNickname
      }
    })
    .catch(() => {
      // Keep the authenticated email as a safe offline fallback.
    })

  unsubGoals = onSnapshot(q, (snap) => {
    loading.hidden = true
    list.innerHTML = ""
    latestGoals = snap.docs.map((d) => ({ id: d.id, done: !!d.data().done }))
    if (snap.empty) {
      list.appendChild(
        el(`<li class="empty">No goals yet. Add your first daily goal above.</li>`),
      )
      return
    }
    snap.forEach((docSnap) => {
      list.appendChild(
        buildGoalItem(user.uid, docSnap.id, docSnap.data(), onGoalChecked),
      )
    })
  }, (err) => {
    console.log("[v0] Firestore goals listener unavailable", err.code)
    loading.hidden = true
    list.innerHTML = `<li class="empty">Goals are unavailable while offline. Reconnect to sync your Firestore data.</li>`
  })

  bindThemeToggle(screen)
  root.appendChild(screen)
}

// ---------------------------------------------------------------------------
// A single goal row (with checkbox + note area)
// ---------------------------------------------------------------------------
function buildGoalItem(uid, id, data, onGoalChecked) {
  const goalRef = doc(db, "users", uid, "goals", id)
  const li = el(`
    <li class="goal ${data.done ? "done" : ""}">
      <div class="goal-main">
        <input class="check" type="checkbox" ${data.done ? "checked" : ""}
          aria-label="Mark goal complete" />
        <span class="goal-title">${escapeHtml(data.title)}</span>
        <button class="delete-btn" aria-label="Delete goal" title="Delete">&times;</button>
      </div>
    </li>
  `)

  const checkbox = li.querySelector(".check")
  const deleteBtn = li.querySelector(".delete-btn")

  // Render note area if the goal is done
  const mountNote = (note) => {
    if (li.querySelector(".note-wrap")) return
    const wrap = el(`
      <div class="note-wrap">
        <label>Completion note</label>
        <textarea placeholder="How did it go? Any reflections…">${escapeHtml(
          note || "",
        )}</textarea>
        <div class="note-actions">
          <button class="btn" type="button" data-save>Save note</button>
          <span class="saved-tag" data-saved>Saved ✓</span>
        </div>
      </div>
    `)
    const textarea = wrap.querySelector("textarea")
    const saveBtn = wrap.querySelector("[data-save]")
    const savedTag = wrap.querySelector("[data-saved]")

    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true
      await updateDoc(goalRef, { note: textarea.value })
      saveBtn.disabled = false
      savedTag.classList.add("show")
      setTimeout(() => savedTag.classList.remove("show"), 1500)
    })

    li.appendChild(wrap)
    textarea.focus()
  }

  if (data.done) mountNote(data.note)

  checkbox.addEventListener("change", async () => {
    const done = checkbox.checked
    await updateDoc(goalRef, { done })
    if (done) {
      const { streak: newStreak, freezeUsed } = await bumpStreak(uid)
      // onSnapshot re-renders, but mount immediately for snappy UX
      mountNote(data.note)
      if (typeof onGoalChecked === "function") onGoalChecked(newStreak, id, freezeUsed)
    } else {
      const wrap = li.querySelector(".note-wrap")
      if (wrap) wrap.remove()
    }
  })

  deleteBtn.addEventListener("click", async () => {
    await deleteDoc(goalRef)
  })

  return li
}

// ---------------------------------------------------------------------------
// LUMIP milestone celebration card
// ---------------------------------------------------------------------------
function showMilestone(streak) {
  // Avoid stacking duplicates.
  if (document.querySelector(".milestone-overlay")) return

  const overlay = el(`
    <div class="milestone-overlay" role="dialog" aria-modal="true" aria-label="LUMIP milestone reached">
      <div class="milestone-card">
        <button class="milestone-close" data-close aria-label="Close">&times;</button>
        <div class="milestone-spark">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 1.5c.6 5.4 4.6 9.4 10 10-5.4.6-9.4 4.6-10 10-.6-5.4-4.6-9.4-10-10 5.4-.6 9.4-4.6 10-10Z" />
          </svg>
        </div>
        ${brandMarkup}
        <div class="milestone-number">${streak}</div>
        <div class="milestone-unit">day streak</div>
        <p class="milestone-copy">
          Every goal checked off today &mdash; and you&apos;ve kept LUMIP glowing
          for <strong>${streak} days</strong>. That&apos;s a milestone worth sharing.
        </p>
        <div class="milestone-actions">
          <button class="btn" type="button" data-share>Share achievement</button>
          <span class="milestone-hint" data-hint></span>
        </div>
      </div>
    </div>
  `)

  const closeBtn = overlay.querySelector("[data-close]")
  const shareBtn = overlay.querySelector("[data-share]")
  const hint = overlay.querySelector("[data-hint]")

  const close = () => overlay.remove()
  closeBtn.addEventListener("click", close)
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close()
  })

  const shareData = {
    title: "LUMIP",
    text: `I just hit a ${streak}-day streak on LUMIP by completing all my daily goals!`,
    url: window.location.href,
  }

  shareBtn.addEventListener("click", async () => {
    hint.textContent = ""
    try {
      if (navigator.share) {
        await navigator.share(shareData)
      } else {
        await navigator.clipboard.writeText(`${shareData.text} ${shareData.url}`)
        hint.textContent = "Copied to clipboard"
      }
    } catch {
      // User dismissed the share sheet, or sharing was blocked — no-op.
    }
  })

  root.appendChild(overlay)
  closeBtn.focus()
}

// ---------------------------------------------------------------------------
// Streak freeze toast — brief, non-blocking notice shown when a Streak Freeze
// was auto-consumed to protect a streak after a missed day.
// ---------------------------------------------------------------------------
function showFreezeToast() {
  document.querySelector(".freeze-toast")?.remove()
  const toast = el(`
    <div class="freeze-toast" role="status">
      <span aria-hidden="true">❄️</span>
      <span>Streak Freeze used — your streak is safe.</span>
    </div>
  `)
  root.appendChild(toast)
  setTimeout(() => toast.remove(), 3000)
}

function escapeHtml(str = "") {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
if (!isFirebaseConfigured) {
  renderSetup()
} else {
  // Render login immediately so a slow/offline Firebase client never leaves a blank loader.
  renderAuth()
  onAuthStateChanged(
    auth,
    (user) => {
      if (user) renderDashboard(user)
      else renderAuth()
    },
    () => {
      // The login screen is already available; auth actions show their own retry state.
      renderAuth()
    },
  )
}

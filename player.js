/**
 * Player Client Controller (Kahoot-Style Flow)
 */

class PlayerController {
    constructor() {
        const urlParams = new URLSearchParams(window.location.search);
        this.roomId = (urlParams.get("room") || "ACM2026").toUpperCase();
        this.sync = new GameSync(this.roomId);

        this.currentPlayer = null; // { id, name }
        this.timeLimitSeconds = 120;
        this.timerCountdownInterval = null;
        this.remainingSeconds = 120;
        this.gameStarted = false;
        this.gameFinished = false;

        this.initDOM();
        this.bindEvents();
        this.listenToSync();
    }

    initDOM() {
        const roomBadge = document.getElementById("displayRoomCode");
        if (roomBadge) roomBadge.textContent = this.roomId;

        // Restore saved player session if reloaded in same room
        try {
            const saved = sessionStorage.getItem(`acm_player_${this.roomId}`);
            if (saved) {
                this.currentPlayer = JSON.parse(saved);
                const nameInput = document.getElementById("inputNickname");
                if (nameInput && this.currentPlayer.name) {
                    nameInput.value = this.currentPlayer.name;
                }
            }
            const activeGame = sessionStorage.getItem(`acm_active_game_${this.roomId}`);
            if (activeGame) {
                this.savedActiveGame = JSON.parse(activeGame);
            }
        } catch (e) {}
    }

    bindEvents() {
        const joinBtn = document.getElementById("btnJoinLobby");
        const nameInput = document.getElementById("inputNickname");

        const submitJoin = async () => {
            const name = nameInput.value.trim();
            this.showError("");

            if (!name) {
                this.showError("Please enter your nickname.");
                return;
            }

            if (name.length > 20) {
                this.showError("Nickname must be 20 characters or less.");
                return;
            }

            joinBtn.disabled = true;
            joinBtn.textContent = "Joining...";

            try {
                const existingId = this.currentPlayer ? this.currentPlayer.id : null;
                const res = await this.sync.joinPlayer(name, existingId);
                if (!res || !res.success) {
                    console.warn("Lobby join notice:", res?.error);
                    // Fallback local join so player is never locked out of gameplay
                    this.currentPlayer = { id: existingId || ("p_" + Date.now()), name: name };
                } else {
                    this.currentPlayer = { id: res.playerId, name: res.player.name };
                }

                try {
                    sessionStorage.setItem(`acm_player_${this.roomId}`, JSON.stringify(this.currentPlayer));
                } catch (e) {}

                // Directly transition into active gameplay view / maze interface
                this.launchGame(this.cachedTimeLimit || 120, this.cachedStartTime || Date.now());
            } catch (err) {
                console.error("Join fallback:", err);
                const fallbackId = (this.currentPlayer && this.currentPlayer.id) ? this.currentPlayer.id : ("p_" + Date.now());
                this.currentPlayer = { id: fallbackId, name: name };
                this.launchGame(this.cachedTimeLimit || 120, Date.now());
            } finally {
                joinBtn.disabled = false;
                joinBtn.textContent = "Join Game";
            }
        };

        if (joinBtn) joinBtn.addEventListener("click", submitJoin);
        if (nameInput) {
            nameInput.addEventListener("keydown", (e) => {
                if (e.key === "Enter") submitJoin();
            });
        }

        // Leaderboard Navigation Buttons
        const joinLeaderboardBtn = document.getElementById("btnJoinViewLeaderboard");
        if (joinLeaderboardBtn) {
            joinLeaderboardBtn.addEventListener("click", () => {
                this.switchScreen("screenLeaderboard");
                this.renderLeaderboard(this.sync.lastState || {});
            });
        }

        const viewLeaderboardBtn = document.getElementById("btnViewLeaderboard");
        if (viewLeaderboardBtn) {
            viewLeaderboardBtn.addEventListener("click", () => {
                this.switchScreen("screenLeaderboard");
                this.renderLeaderboard(this.sync.lastState || {});
            });
        }

        const backToGameBtn = document.getElementById("btnBackToGame");
        if (backToGameBtn) {
            backToGameBtn.addEventListener("click", () => {
                if (this.gameStarted) {
                    this.switchScreen("screenGame");
                    if (window.gameInstance) window.gameInstance.resizeCanvas();
                } else if (this.currentPlayer) {
                    this.launchGame(this.cachedTimeLimit || 120, this.cachedStartTime || Date.now());
                } else {
                    this.switchScreen("screenJoin");
                }
            });
        }

        const finishedLeaderboardBtn = document.getElementById("btnFinishedViewLeaderboard");
        if (finishedLeaderboardBtn) {
            finishedLeaderboardBtn.addEventListener("click", () => {
                this.showLeaderboard(this.sync.lastState || {});
            });
        }
    }

    showError(msg) {
        const el = document.getElementById("joinErrorBanner");
        if (!el) return;
        if (!msg) {
            el.style.display = "none";
            el.textContent = "";
        } else {
            el.style.display = "block";
            el.textContent = msg;
        }
    }

    switchScreen(screenId) {
        document.querySelectorAll(".app-screen").forEach(el => el.classList.remove("active"));
        const target = document.getElementById(screenId);
        if (target) target.classList.add("active");
    }

    showLobbyWaiting() {
        const nameDisplay = document.getElementById("waitingPlayerName");
        if (nameDisplay && this.currentPlayer) {
            nameDisplay.textContent = this.currentPlayer.name;
        }
        this.switchScreen("screenLobbyWaiting");
    }

    showCountdownOverlay() {
        if (this.isCountingDown) return; // Prevent repeated reset while countdown is actively ticking
        this.isCountingDown = true;

        const overlay = document.getElementById("countdownOverlay");
        const numEl = document.getElementById("countdownNumber");
        const subEl = document.getElementById("countdownSubtitle");
        if (!overlay || !numEl) return;

        overlay.classList.add("active");
        let count = 3;
        numEl.textContent = count;
        numEl.style.color = "#38bdf8";
        if (subEl) subEl.textContent = "GET READY!";

        if (window.gameInstance && window.gameInstance.sound) {
            window.gameInstance.sound.init();
            window.gameInstance.sound.playCountdownBeep(false);
        }

        if (this.countdownTimerInterval) clearInterval(this.countdownTimerInterval);
        this.countdownTimerInterval = setInterval(() => {
            count--;
            if (count > 0) {
                numEl.textContent = count;
                numEl.style.animation = 'none';
                void numEl.offsetWidth;
                numEl.style.animation = 'zoomPulse 1s ease-in-out infinite';

                if (window.gameInstance && window.gameInstance.sound) {
                    window.gameInstance.sound.playCountdownBeep(false);
                }
            } else if (count === 0) {
                numEl.textContent = "GO!";
                numEl.style.color = "#00f5d4";
                numEl.style.animation = 'none';
                void numEl.offsetWidth;
                numEl.style.animation = 'zoomPulse 1s ease-in-out infinite';

                if (subEl) subEl.textContent = "FIND LETTERS A, C, M!";
                if (window.gameInstance && window.gameInstance.sound) {
                    window.gameInstance.sound.playCountdownBeep(true);
                }

                // EXACT 3-SECOND MARK: START GAME IMMEDIATELY WITH ZERO DELAY!
                if (this.currentPlayer && !this.gameStarted && !this.gameFinished) {
                    this.launchGame(this.cachedTimeLimit || 120, this.cachedStartTime || Date.now(), this.cachedMatchEndTime);
                }

                // Hide overlay after quick 350ms "GO!" flash directly into the live game
                setTimeout(() => {
                    this.hideCountdownOverlay();
                }, 350);

                clearInterval(this.countdownTimerInterval);
                this.countdownTimerInterval = null;
            }
        }, 1000);
    }

    hideCountdownOverlay() {
        this.isCountingDown = false;
        if (this.countdownTimerInterval) {
            clearInterval(this.countdownTimerInterval);
            this.countdownTimerInterval = null;
        }
        const overlay = document.getElementById("countdownOverlay");
        if (overlay) overlay.classList.remove("active");
    }

    listenToSync() {
        this.sync.onUpdate((state) => {
            const now = Date.now();
            const limit = state.timeLimit || 120;
            const endTime = state.matchEndTime || (state.startTime ? state.startTime + (limit * 1000) : null);
            const remaining = endTime ? Math.ceil((endTime - now) / 1000) : limit;

            // If host triggers 3-second countdown
            if (state.status === "COUNTDOWN") {
                this.cachedTimeLimit = limit;
                this.cachedStartTime = state.startTime || (state.countdownStart ? state.countdownStart + 3000 : now + 3000);
                this.cachedMatchEndTime = endTime || (this.cachedStartTime + limit * 1000);
                if (this.currentPlayer && !this.gameStarted) {
                    this.switchScreen("screenGame");
                    if (window.gameInstance) {
                        window.gameInstance.resizeCanvas();
                    }
                    this.showCountdownOverlay();
                }
            } else if (state.status === "STARTED") {
                this.hideCountdownOverlay();
                if (this.currentPlayer) {
                    // Check if time expired according to server-authoritative global match clock
                    if (endTime && remaining <= 0) {
                        this.handleTimeExpired();
                    } else if (!this.gameStarted && !this.gameFinished) {
                        // Rehydrate or launch session directly into active game view
                        this.launchGame(limit, state.startTime, endTime);
                    } else if (this.gameStarted) {
                        // Keep server-authoritative clock synchronized
                        this.matchEndTime = endTime;
                        this.remainingSeconds = remaining;
                        this.updateTimerDisplay();
                    }
                }
            } else if (state.status === "ENDED") {
                this.hideCountdownOverlay();
                if (this.currentPlayer && (this.gameFinished || this.savedActiveGame)) {
                    this.showLeaderboard(state);
                }
            } else if (state.status === "LOBBY") {
                this.hideCountdownOverlay();
                if (!this.gameStarted) {
                    if (this.currentPlayer) {
                        this.launchGame();
                    } else {
                        this.switchScreen("screenJoin");
                    }
                }
            }
        });
    }

    launchGame(timeLimit, startTime, matchEndTime) {
        if (this.gameStarted) return;
        this.gameStarted = true;
        this.gameFinished = false;
        this.finishTimestamp = null;
        this.timeLimitSeconds = timeLimit || 120;

        const now = Date.now();
        this.matchEndTime = matchEndTime || (startTime ? startTime + (this.timeLimitSeconds * 1000) : now + (this.timeLimitSeconds * 1000));
        this.remainingSeconds = Math.max(0, Math.ceil((this.matchEndTime - now) / 1000));

        this.switchScreen("screenGame");

        // Start countdown timer banner
        const timerVal = document.getElementById("timerVal");
        const statusBanner = document.getElementById("statusBanner");
        if (statusBanner) {
            const mins = Math.floor(this.timeLimitSeconds / 60);
            const secs = this.timeLimitSeconds % 60;
            const timeFormatted = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
            const minuteWord = mins === 1 && secs === 0 ? "1 minute" : `${mins} minutes`;
            statusBanner.textContent = `Race to find letters A, C, M! You have ${minuteWord} (${timeFormatted})!`;
        }

        if (this.timerCountdownInterval) clearInterval(this.timerCountdownInterval);
        this.updateTimerDisplay();

        // Server-Authoritative Global Match Clock Ticker
        this.timerCountdownInterval = setInterval(() => {
            const currentNow = Date.now();
            this.remainingSeconds = Math.max(0, Math.ceil((this.matchEndTime - currentNow) / 1000));
            this.updateTimerDisplay();

            if (this.remainingSeconds <= 0) {
                clearInterval(this.timerCountdownInterval);
                this.handleTimeExpired();
            }
        }, 1000);

        // Rehydrate or reset game instance
        if (window.gameInstance) {
            window.gameInstance.resizeCanvas();
            let rehydrated = false;
            if (this.savedActiveGame) {
                rehydrated = window.gameInstance.rehydrate(this.savedActiveGame);
            }
            if (!rehydrated) {
                const seed = (this.sync && this.sync.cachedState && this.sync.cachedState.mazeSeed) || null;
                window.gameInstance.resetGame(seed);
            }
            window.gameInstance.onSpellComplete = (stats) => {
                this.onPlayerCompletedSpell(stats);
            };
        }
    }

    updateTimerDisplay() {
        const timerVal = document.getElementById("timerVal");
        if (timerVal) {
            const clamped = Math.max(0, this.remainingSeconds);
            const mins = String(Math.floor(clamped / 60)).padStart(2, '0');
            const secs = String(clamped % 60).padStart(2, '0');
            timerVal.textContent = `${mins}:${secs}`;
            if (clamped <= 15) {
                timerVal.style.color = '#ef4444';
            } else {
                timerVal.style.color = '#38bdf8';
            }
        }
    }

    onPlayerCompletedSpell(stats) {
        if (this.gameFinished) return;
        this.gameFinished = true;
        this.finishTimestamp = Date.now();
        if (this.timerCountdownInterval) clearInterval(this.timerCountdownInterval);

        const timeTaken = stats.seconds;
        const mins = String(Math.floor(timeTaken / 60)).padStart(2, '0');
        const secs = String(timeTaken % 60).padStart(2, '0');
        const formatted = `${mins}:${secs}`;

        // Sync to host/cloud
        if (this.currentPlayer) {
            this.sync.markPlayerFinished(this.currentPlayer.id, timeTaken, formatted);
        }

        // Show player finished waiting page:
        // "after collecting all letters people automatically land on waiting page again until timer goes off or host end game."
        const finishTimeDisplay = document.getElementById("finishedTimeDisplay");
        const finishStepsDisplay = document.getElementById("finishedStepsDisplay");
        const finishOrderDisplay = document.getElementById("finishedOrderDisplay");

        if (finishTimeDisplay) finishTimeDisplay.textContent = formatted;
        if (finishStepsDisplay) finishStepsDisplay.textContent = stats.steps;
        if (finishOrderDisplay) finishOrderDisplay.textContent = stats.sequence.join(' ➔ ');

        this.switchScreen("screenFinishedWaiting");
        try {
            sessionStorage.removeItem(`acm_active_game_${this.roomId}`);
        } catch (e) {}

        // Victory event: automatically reveal leaderboard rankings after brief celebratory card
        setTimeout(() => {
            this.showLeaderboard(this.sync.lastState || {});
        }, 2500);
    }

    handleTimeExpired() {
        if (this.gameFinished) return;
        this.gameFinished = true;
        this.finishTimestamp = null;
        try {
            sessionStorage.removeItem(`acm_active_game_${this.roomId}`);
        } catch (e) {}

        // Player ran out of time without finding all letters (Game over event)
        this.switchScreen("screenFinishedWaiting");
        const title = document.getElementById("finishedTitle");
        const desc = document.getElementById("finishedDesc");
        if (title) title.textContent = "⏰ TIME'S UP!";
        if (desc) desc.textContent = "Round has concluded. Calculating final leaderboard rankings...";

        setTimeout(() => {
            this.showLeaderboard(this.sync.lastState || {});
        }, 2000);
    }

    showLeaderboard(state) {
        if (this.timerCountdownInterval) clearInterval(this.timerCountdownInterval);

        // If player completed the spell very recently, give them a brief moment to see
        // their completion card before automatically transitioning to the podium
        const now = Date.now();
        const timeSinceFinish = this.finishTimestamp ? (now - this.finishTimestamp) : 9999;
        const delay = Math.max(0, 1600 - timeSinceFinish);

        if (delay > 0) {
            const desc = document.getElementById("finishedDesc");
            if (desc) {
                desc.textContent = "🎉 All players have finished! Revealing final rankings...";
            }
            setTimeout(() => {
                this.renderLeaderboard(state);
            }, delay);
        } else {
            this.renderLeaderboard(state);
        }
    }

    renderLeaderboard(state) {
        this.switchScreen("screenLeaderboard");

        // Calculate and sort rankings
        const playerList = Object.values(state.players || {});
        playerList.sort((a, b) => {
            if (a.finished && !b.finished) return -1;
            if (!a.finished && b.finished) return 1;
            if (a.finished && b.finished) {
                return (a.finishTimeSeconds || 9999) - (b.finishTimeSeconds || 9999);
            }
            return 0;
        });

        // Personal rank announcement
        const myRankEl = document.getElementById("myRankAnnouncement");
        if (myRankEl && this.currentPlayer) {
            const idx = playerList.findIndex(p => p.id === this.currentPlayer.id);
            if (idx !== -1) {
                const rankNum = idx + 1;
                const me = playerList[idx];
                if (me.finished) {
                    myRankEl.innerHTML = `🎉 You ranked <strong>#${rankNum}</strong> out of ${playerList.length} players! (Time: ${me.finishTimeFormatted})`;
                } else {
                    myRankEl.innerHTML = `You completed the round ranked <strong>#${rankNum}</strong>!`;
                }
            }
        }

        // Podium render
        const p1Name = document.getElementById("podium1Name");
        const p1Time = document.getElementById("podium1Time");
        const p2Name = document.getElementById("podium2Name");
        const p2Time = document.getElementById("podium2Time");
        const p3Name = document.getElementById("podium3Name");
        const p3Time = document.getElementById("podium3Time");

        if (playerList[0]) {
            if (p1Name) p1Name.textContent = playerList[0].name;
            if (p1Time) p1Time.textContent = playerList[0].finished ? `⏱️ ${playerList[0].finishTimeFormatted}` : 'Exploring';
        } else {
            if (p1Name) p1Name.textContent = '-';
            if (p1Time) p1Time.textContent = '-';
        }

        if (playerList[1]) {
            if (p2Name) p2Name.textContent = playerList[1].name;
            if (p2Time) p2Time.textContent = playerList[1].finished ? `⏱️ ${playerList[1].finishTimeFormatted}` : 'Exploring';
        } else {
            if (p2Name) p2Name.textContent = '-';
            if (p2Time) p2Time.textContent = '-';
        }

        if (playerList[2]) {
            if (p3Name) p3Name.textContent = playerList[2].name;
            if (p3Time) p3Time.textContent = playerList[2].finished ? `⏱️ ${playerList[2].finishTimeFormatted}` : 'Exploring';
        } else {
            if (p3Name) p3Name.textContent = '-';
            if (p3Time) p3Time.textContent = '-';
        }

        // Full rankings table
        const tbody = document.getElementById("leaderboardBody");
        if (tbody) {
            tbody.innerHTML = "";
            playerList.forEach((p, idx) => {
                const tr = document.createElement("tr");
                tr.className = `rank-row ${this.currentPlayer && p.id === this.currentPlayer.id ? 'highlight-me' : ''}`;
                tr.innerHTML = `
                    <td style="font-weight: 800;">#${idx + 1}</td>
                    <td>${this.escape(p.name)} ${this.currentPlayer && p.id === this.currentPlayer.id ? '<em>(You)</em>' : ''}</td>
                    <td>${p.finished ? `<span style="color: #00f5d4; font-weight: 700;">Completed (${p.finishTimeFormatted})</span>` : '<span style="color: #94a3b8;">Incomplete</span>'}</td>
                `;
                tbody.appendChild(tr);
            });
        }
    }

    escape(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
}

window.addEventListener("DOMContentLoaded", () => {
    window.playerClient = new PlayerController();
});

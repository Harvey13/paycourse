// État global
let currentDate = new Date();
let selectedDate = null;
let settings = {
    coursePrice: 15,
    studentName: '',
    teacherName: '',
    userMode: 'student'
};
let courseData = {};
let syncChannel = null;

// Initialisation
document.addEventListener('DOMContentLoaded', async () => {
    await loadSettings();
    await loadCourseData();
    setupEventListeners();
    setupSync();
    renderCalendar();

    const today = getDateKey(new Date());
    if (!selectedDate) {
        selectDate(today);
    } else {
        renderDetail(selectedDate);
    }

    if (window.supabase && isSupabaseConfigured()) {
        setupRealtimeListener();
    }
});

function getDateKey(date) {
    const local = new Date(date);
    local.setHours(0, 0, 0, 0);
    return `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
}

function isSupabaseConfigured() {
    const url = window.supabase?.supabaseUrl || '';
    const key = window.supabase?.supabaseKey || '';
    return Boolean(url && key && !url.includes('VOTRE_PROJET') && !key.includes('VOTRE'));
}

// Charger les paramètres depuis localStorage
async function loadSettings() {
    const saved = localStorage.getItem('paycourse_settings');
    if (saved) {
        settings = JSON.parse(saved);
    }

    const coursePriceInput = document.getElementById('coursePrice');
    const studentNameInput = document.getElementById('studentName');
    const teacherNameInput = document.getElementById('teacherName');
    const userModeInput = document.getElementById('userMode');

    if (coursePriceInput) coursePriceInput.value = settings.coursePrice;
    if (studentNameInput) studentNameInput.value = settings.studentName;
    if (teacherNameInput) teacherNameInput.value = settings.teacherName;
    if (userModeInput) userModeInput.value = settings.userMode;
}

function loadFromLocalStorage() {
    const saved = localStorage.getItem('paycourse_data');
    if (saved) {
        try {
            return JSON.parse(saved);
        } catch (error) {
            console.warn('Données locales invalides :', error);
        }
    }
    return {};
}

function isCourseEntry(data) {
    if (!data || typeof data !== 'object') return false;
    return Boolean(
        data.exists === true ||
        data.createdAt ||
        data.created ||
        data.validated === true ||
        data.hasCredit === true ||
        Number(data.paymentAmount || data.paidAmount || 0) > 0 ||
        Number(data.creditAmount || 0) > 0
    );
}

function sanitizeCourseData(rawData) {
    const sanitized = {};
    let removed = 0;

    Object.entries(rawData || {}).forEach(([key, value]) => {
        if (!value || typeof value !== 'object') return;
        if (isCourseEntry(value)) {
            sanitized[key] = value;
        } else {
            removed += 1;
        }
    });

    if (removed > 0) {
        courseData = sanitized;
        saveToLocalStorage();
    }

    return sanitized;
}

function saveToLocalStorage() {
    localStorage.setItem('paycourse_data', JSON.stringify(courseData));
}

// Charger les données depuis le stockage local puis Supabase si disponible
async function loadCourseData() {
    const rawData = loadFromLocalStorage();
    courseData = sanitizeCourseData(rawData);

    if (window.supabase && isSupabaseConfigured()) {
        try {
            const { data, error } = await window.supabase.from('courses').select('*');
            if (error) throw error;

            const merged = { ...courseData };
            (data || []).forEach(row => {
                merged[row.id] = {
                    ...(merged[row.id] || {}),
                    paidAmount: Number(row.paid_amount || 0),
                    validated: Boolean(row.validated),
                    hasCredit: Boolean(row.has_credit),
                    timestamp: row.updated_at || merged[row.id]?.timestamp
                };
            });
            courseData = merged;
            saveToLocalStorage();
        } catch (error) {
            console.warn('Supabase indisponible, utilisation du stockage local :', error);
        }
    }
}

function broadcastSync() {
    if (syncChannel) {
        syncChannel.postMessage({ type: 'paycourse-update' });
    }
    saveToLocalStorage();
}

function setupSync() {
    if ('BroadcastChannel' in window) {
        syncChannel = new BroadcastChannel('paycourse-sync');
        syncChannel.onmessage = async (event) => {
            if (event.data?.type === 'paycourse-update') {
                await loadCourseData();
                renderCalendar();
                if (selectedDate) {
                    renderDetail(selectedDate);
                }
            }
        };
    }

    window.addEventListener('storage', async (event) => {
        if (event.key === 'paycourse_data') {
            await loadCourseData();
            renderCalendar();
            if (selectedDate) {
                renderDetail(selectedDate);
            }
        }
    });
}

// Écoute en temps réel
function setupRealtimeListener() {
    window.supabase
        .channel('courses-changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'courses' }, async () => {
            await loadCourseData();
            renderCalendar();
            if (selectedDate) {
                renderDetail(selectedDate);
            }
        })
        .subscribe();
}

function getPriorBalance(dateStr) {
    let balance = 0;
    const keys = Object.keys(courseData)
        .filter(key => key < dateStr)
        .sort();

    keys.forEach(key => {
        const record = courseData[key] || {};
        if (!isCourseEntry(record)) return;
        const payment = Number(record.paymentAmount || record.paidAmount || 0);
        balance += payment - settings.coursePrice;
    });

    return balance;
}

function recomputeCourseData() {
    const sortedKeys = Object.keys(courseData)
        .filter(key => isCourseEntry(courseData[key]))
        .sort();

    let balance = 0;
    sortedKeys.forEach(key => {
        const record = courseData[key] || {};
        const rawPayment = Math.max(0, Number(record.paymentAmount ?? record.paidAmount ?? 0));
        const priorDebt = Math.max(0, -balance);
        const debtPayment = Math.min(rawPayment, priorDebt);
        const remainingAfterDebt = Math.max(0, rawPayment - debtPayment);
        const courseDue = Math.max(0, settings.coursePrice - Math.max(0, balance));
        const currentPayment = Math.min(remainingAfterDebt, courseDue);
        const credit = Math.max(0, remainingAfterDebt - currentPayment);
        const effectivePaid = debtPayment + currentPayment;

        courseData[key] = {
            ...(record || {}),
            exists: true,
            paymentAmount: rawPayment,
            paidAmount: effectivePaid,
            previousDebt: priorDebt,
            currentDue: courseDue,
            debtPayment,
            currentPayment,
            creditAmount: credit,
            hasCredit: credit > 0,
            timestamp: new Date().toISOString()
        };

        balance += effectivePaid - settings.coursePrice;
    });
}

function getAllocation(dateStr, paidAmount) {
    const priorBalance = getPriorBalance(dateStr);
    const currentDue = Math.max(0, settings.coursePrice - Math.max(0, priorBalance));
    let remaining = Math.max(0, Number(paidAmount) || 0);

    const debtPayment = Math.min(remaining, Math.max(0, -priorBalance));
    remaining -= debtPayment;

    const currentPayment = Math.min(remaining, currentDue);
    remaining -= currentPayment;
    const credit = remaining;

    return {
        priorBalance,
        previousDebt: Math.max(0, -priorBalance),
        currentDue,
        debtPayment,
        currentPayment,
        credit
    };
}

function getCourseExportSummary(dateStr, data) {
    const paidAmount = Number(data.paymentAmount ?? data.paidAmount ?? 0);
    const allocation = getAllocation(dateStr, paidAmount);
    const currentDue = Math.max(0, settings.coursePrice - Math.max(0, allocation.priorBalance));
    const totalDue = currentDue + allocation.previousDebt;

    let status = 'Non payé';
    let excess = 0;
    let remainingToPay = Math.max(0, totalDue - paidAmount);

    if (paidAmount > 0) {
        if (paidAmount > totalDue) {
            status = 'Payé intégralement + excédent';
            excess = paidAmount - totalDue;
            remainingToPay = 0;
        } else if (paidAmount === totalDue) {
            status = 'Payé intégralement';
        } else {
            status = 'Partiellement payé';
        }
    }

    return {
        date: dateStr,
        etat: status,
        montantSaisi: paidAmount,
        excedent: excess,
        resteAPayer: remainingToPay,
        valide: Boolean(data.validated)
    };
}

function exportCourseAnalysis() {
    const rows = Object.keys(courseData)
        .filter(key => isCourseEntry(courseData[key]))
        .sort()
        .map(key => {
            const summary = getCourseExportSummary(key, courseData[key] || {});
            return [
                summary.date,
                summary.etat,
                summary.montantSaisi.toFixed(2),
                summary.excedent.toFixed(2),
                summary.resteAPayer.toFixed(2),
                summary.valide ? 'Oui' : 'Non'
            ];
        });

    const headers = ['Date', 'État', 'Montant saisi (€)', 'Excédent (€)', 'Reste à payer (€)', 'Validé'];
    const csvContent = [headers, ...rows]
        .map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(','))
        .join('\n');

    const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'analyse-cours.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

// Sauvegarder le paiement
async function savePayment(dateStr) {
    const paidAmount = parseFloat(document.getElementById('paidAmount').value) || 0;
    const existing = courseData[dateStr] || {};
    courseData[dateStr] = {
        ...(existing || {}),
        exists: true,
        paymentAmount: paidAmount,
        validated: Boolean(existing.validated),
        timestamp: new Date().toISOString()
    };

    recomputeCourseData();

    if (window.supabase && isSupabaseConfigured()) {
        try {
            const currentRecord = courseData[dateStr] || {};
            await window.supabase.from('courses').upsert({
                id: dateStr,
                paid_amount: currentRecord.paidAmount || 0,
                validated: Boolean(currentRecord.validated),
                has_credit: Boolean(currentRecord.hasCredit),
                updated_at: new Date().toISOString()
            });
        } catch (error) {
            console.warn('Impossible d’écrire vers Supabase :', error);
        }
    }

    broadcastSync();
    selectedDate = dateStr;
    renderCalendar();
    renderDetail(dateStr);
    alert('Paiement enregistré !');
}

async function deleteCourse(dateStr) {
    if (!dateStr) return;
    if (!confirm('Supprimer ce cours et revenir à l’état vide ?')) return;

    delete courseData[dateStr];
    saveToLocalStorage();
    broadcastSync();
    selectedDate = dateStr;
    renderCalendar();
    renderDetail(dateStr);
}

async function createCourse(dateStr) {
    if (!dateStr) return;

    const existing = courseData[dateStr] || {};
    courseData[dateStr] = {
        ...existing,
        exists: true,
        createdAt: new Date().toISOString(),
        paidAmount: Number(existing.paidAmount || 0),
        paymentAmount: Number(existing.paymentAmount || 0),
        validated: Boolean(existing.validated),
        hasCredit: Boolean(existing.hasCredit)
    };

    saveToLocalStorage();
    broadcastSync();
    selectedDate = dateStr;
    renderCalendar();
    renderDetail(dateStr);
}

// Toggle validation professeur
async function toggleValidation(dateStr, validated) {
    if (!courseData[dateStr]) {
        courseData[dateStr] = { paidAmount: 0, validated: false };
    }

    courseData[dateStr] = {
        ...courseData[dateStr],
        validated: validated,
        timestamp: new Date().toISOString()
    };

    if (window.supabase && isSupabaseConfigured()) {
        try {
            await window.supabase.from('courses').upsert({
                id: dateStr,
                paid_amount: courseData[dateStr].paidAmount || 0,
                validated: validated,
                has_credit: courseData[dateStr].hasCredit || false,
                updated_at: new Date().toISOString()
            });
        } catch (error) {
            console.warn('Impossible de mettre à jour la validation :', error);
        }
    }

    broadcastSync();
    selectedDate = dateStr;
    renderCalendar();
    renderDetail(dateStr);
}

// Réinitialiser les données
function resetData() {
    if (confirm('Êtes-vous sûr de vouloir réinitialiser toutes les données ?')) {
        courseData = {};
        localStorage.removeItem('paycourse_data');

        if (window.supabase && isSupabaseConfigured()) {
            window.supabase.from('courses').delete().neq('id', '').then(() => console.log('Données Supabase effacées'));
        }

        renderCalendar();
        document.getElementById('detailContent').innerHTML = '<p class="placeholder">Sélectionnez un jour</p>';
        document.getElementById('settingsModal').classList.remove('active');
    }
}

// Navigation mois
function setupEventListeners() {
    const prevMonthButton = document.getElementById('prevMonth');
    const nextMonthButton = document.getElementById('nextMonth');
    const settingsButton = document.getElementById('settingsBtn');
    const closeSettingsButton = document.getElementById('closeSettings');
    const saveSettingsButton = document.getElementById('saveSettings');
    const exportButton = document.getElementById('exportCourseData');
    const resetButton = document.getElementById('resetData');

    prevMonthButton?.addEventListener('click', () => {
        currentDate.setMonth(currentDate.getMonth() - 1);
        renderCalendar();
    });

    nextMonthButton?.addEventListener('click', () => {
        currentDate.setMonth(currentDate.getMonth() + 1);
        renderCalendar();
    });

    settingsButton?.addEventListener('click', () => {
        document.getElementById('settingsModal').classList.add('active');
    });

    closeSettingsButton?.addEventListener('click', () => {
        document.getElementById('settingsModal').classList.remove('active');
    });

    saveSettingsButton?.addEventListener('click', saveSettings);
    exportButton?.addEventListener('click', exportCourseAnalysis);
    resetButton?.addEventListener('click', resetData);
}

// Sauvegarder les paramètres
function saveSettings() {
    settings.coursePrice = parseFloat(document.getElementById('coursePrice').value) || 15;
    settings.studentName = document.getElementById('studentName').value;
    settings.teacherName = document.getElementById('teacherName').value;
    settings.userMode = document.getElementById('userMode').value;

    localStorage.setItem('paycourse_settings', JSON.stringify(settings));
    document.getElementById('settingsModal').classList.remove('active');

    renderCalendar();
    if (selectedDate) {
        renderDetail(selectedDate);
    }

    alert('Paramètres enregistrés !');
}

// Rendu du calendrier
function renderCalendar() {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();

    const monthLabel = document.getElementById('currentMonth');
    if (monthLabel) {
        monthLabel.textContent = new Date(year, month).toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    }

    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startDay = (firstDay.getDay() + 6) % 7;

    const grid = document.getElementById('calendarGrid');
    if (!grid) return;
    grid.innerHTML = '';

    for (let i = 0; i < startDay; i++) {
        const cell = document.createElement('div');
        cell.className = 'day-cell empty';
        grid.appendChild(cell);
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (let day = 1; day <= lastDay.getDate(); day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const cell = document.createElement('div');
        cell.className = 'day-cell';
        cell.textContent = day;

        const data = courseData[dateStr] || {};
        const dateObj = new Date(`${dateStr}T00:00:00`);
        const isFuture = dateObj > today;
        const hasCourse = isCourseEntry(data);
        const paidAmount = Number(data.paidAmount || data.paymentAmount || 0);
        const isPrepaidFuture = isFuture && hasCourse && paidAmount > 0;
        const isFutureUnpaid = isFuture && hasCourse && paidAmount === 0;

        cell.className = 'day-cell';
        if (dateStr === selectedDate) {
            cell.classList.add('selected');
        }

        if (hasCourse) {
            if (data.validated) {
                const check = document.createElement('span');
                check.className = 'validation-check';
                check.textContent = '✓';
                cell.appendChild(check);
            }

            if (data.hasCredit && Number(data.paidAmount || 0) === 0) {
                cell.classList.add('credit');
            } else if (isFuture && paidAmount >= settings.coursePrice) {
                cell.classList.add('future-paid');
            } else if (isFuture && paidAmount > 0) {
                cell.classList.add('future-paid');
            } else if (isFuture && paidAmount === 0) {
                cell.classList.add('future-unpaid');
            } else if (paidAmount >= settings.coursePrice) {
                cell.classList.add('paid');
            } else if (paidAmount > 0) {
                cell.classList.add('partial');
            } else {
                cell.classList.add('unpaid');
            }
        } else {
            if (isFuture) {
                cell.classList.add('future-empty');
            } else {
                cell.classList.add('blank');
            }
        }

        cell.addEventListener('click', () => selectDate(dateStr));
        grid.appendChild(cell);
    }
}

// Sélection d'une date
function selectDate(dateStr) {
    selectedDate = dateStr;
    renderCalendar();
    renderDetail(dateStr);
}

// Rendu du détail
function renderDetail(dateStr) {
    const content = document.getElementById('detailContent');
    if (!content) return;

    if (!dateStr) {
        content.innerHTML = '<p class="placeholder">Sélectionnez un jour</p>';
        return;
    }

    const data = courseData[dateStr] || { paidAmount: 0, validated: false, hasCredit: false, paymentAmount: 0 };
    const hasCourse = Boolean(data.exists || data.courseExists || data.createdAt || data.created || data.validated || data.hasCredit || Number(data.paymentAmount || data.paidAmount || 0) > 0);
    const isTeacher = settings.userMode === 'teacher';
    const date = new Date(`${dateStr}T00:00:00`);
    const dateFormatted = date.toLocaleDateString('fr-FR', {
        weekday: 'long',
        day: 'numeric',
        month: 'long'
    });
    const paidAmount = Number(data.paymentAmount || data.paidAmount || 0);
    const allocation = getAllocation(dateStr, paidAmount);
    let paymentStatus = 'Non payé';
    let paymentExtra = 0;
    const currentDue = Math.max(0, settings.coursePrice - Math.max(0, allocation.priorBalance));
    const totalDue = currentDue + allocation.previousDebt;
    let debtToPay = Math.max(0, totalDue - paidAmount);

    if (paidAmount > 0) {
        if (paidAmount > totalDue) {
            paymentStatus = 'Payé intégralement + excédent';
            paymentExtra = paidAmount - totalDue;
            debtToPay = 0;
        } else if (paidAmount === totalDue) {
            paymentStatus = 'Payé intégralement';
            debtToPay = 0;
        } else {
            paymentStatus = 'Partiellement payé';
            debtToPay = totalDue - paidAmount;
        }
    }

    let html = `
        <div class="detail-row">
            <label>Date :</label>
            <span>${dateFormatted}</span>
        </div>
        <div class="detail-row">
            <label>Prix du cours :</label>
            <span>${settings.coursePrice} €</span>
        </div>
    `;

    if (!hasCourse) {
        html += `
            <div class="detail-summary">
                <strong>Aucun cours créé</strong><br>
                Cliquez sur le bouton ci-dessous pour créer ce cours dans la base.
            </div>
            <button id="createCourse" class="btn-primary">Créer le cours</button>
        `;
        content.innerHTML = html;
        document.getElementById('createCourse').addEventListener('click', () => createCourse(dateStr));
        return;
    }

    const debtExplanation = allocation.previousDebt > 0
        ? `<br><strong>Reste à payer :</strong> ${debtToPay.toFixed(2)} € (${settings.coursePrice.toFixed(2)} € + ${allocation.previousDebt.toFixed(2)} € de dette précédente)`
        : allocation.priorBalance > 0 && debtToPay > 0
            ? `<br><strong>Reste à payer :</strong> ${debtToPay.toFixed(2)} € (${settings.coursePrice.toFixed(2)} € - ${Math.abs(allocation.priorBalance).toFixed(2)} € d'excédent)`
            : `${debtToPay > 0 ? `<br><strong>Reste à payer :</strong> ${debtToPay.toFixed(2)} €` : ''}`;

    html += `
        <div class="detail-summary">
            <strong>État :</strong> ${paymentStatus}<br>
            <strong>Montant saisi :</strong> ${paidAmount.toFixed(2)} €${paymentExtra > 0 ? `<br><strong>Excédent :</strong> ${paymentExtra.toFixed(2)} €` : ''}${debtExplanation}
        </div>
    `;

    if (isTeacher) {
        html += `
            <div class="detail-row">
                <label>Montant versé :</label>
                <span>${Number(data.paymentAmount || data.paidAmount || 0).toFixed(2)} €</span>
            </div>
            <div class="validation-toggle">
                <input type="checkbox" id="validationCheck" ${data.validated ? 'checked' : ''}>
                <label for="validationCheck">Valider la réception</label>
            </div>
        `;
    } else {
        const allocation = getAllocation(dateStr, paidAmount);
        html += `
            <div class="detail-row">
                <label>Montant versé :</label>
                <input type="number" id="paidAmount" value="${Number(data.paymentAmount || data.paidAmount || 0).toFixed(2)}" min="0" step="0.01" placeholder="Ex. 15">
            </div>
            <div class="amount-presets">
                <button type="button" class="preset-btn" data-value="10">10 €</button>
                <button type="button" class="preset-btn" data-value="15">15 €</button>
                <button type="button" class="preset-btn" data-value="20">20 €</button>
                <button type="button" class="preset-btn" data-value="30">30 €</button>
            </div>
            <div class="button-group compact">
                <button id="validatePayment" class="btn-primary">Valider le paiement</button>
                <button id="deleteCourse" class="btn-secondary">Supprimer</button>
            </div>
        `;
    }

    content.innerHTML = html;

    if (!isTeacher) {
        const amountInput = document.getElementById('paidAmount');
        updateBreakdown();
        amountInput?.addEventListener('input', updateBreakdown);
        amountInput?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                savePayment(dateStr);
            }
        });
        document.querySelectorAll('.preset-btn').forEach(button => {
            button.addEventListener('click', () => {
                if (amountInput) {
                    amountInput.value = button.getAttribute('data-value');
                    updateBreakdown();
                    amountInput.focus();
                }
            });
        });
        document.getElementById('validatePayment').addEventListener('click', () => savePayment(dateStr));
        document.getElementById('deleteCourse').addEventListener('click', () => deleteCourse(dateStr));
        setTimeout(() => {
            amountInput?.focus();
            amountInput?.select();
        }, 100);
    } else {
        document.getElementById('validationCheck').addEventListener('change', (e) => {
            toggleValidation(dateStr, e.target.checked);
        });
    }
}

// Calcul de la répartition
function updateBreakdown() {
    const amountInput = document.getElementById('paidAmount');
    const paidAmount = parseFloat(amountInput?.value) || 0;
    const breakdown = document.getElementById('breakdown');
    if (!breakdown) return;

    if (selectedDate) {
        const existing = courseData[selectedDate] || {};
        courseData[selectedDate] = {
            ...(existing || {}),
            exists: true,
            paymentAmount: paidAmount,
            timestamp: new Date().toISOString()
        };
        recomputeCourseData();
        renderCalendar();
    }

    const allocation = getAllocation(selectedDate, paidAmount);

    breakdown.innerHTML = `
        <div class="breakdown-item">
            <span>Dette antérieure :</span>
            <span>${allocation.previousDebt.toFixed(2)} €</span>
        </div>
        <div class="breakdown-item">
            <span>→ Payée :</span>
            <span>${allocation.debtPayment.toFixed(2)} €</span>
        </div>
        <div class="breakdown-item">
            <span>Cours actuel :</span>
            <span>${allocation.currentPayment.toFixed(2)} €</span>
        </div>
        <div class="breakdown-item">
            <span>Avoir futur :</span>
            <span>${allocation.credit.toFixed(2)} €</span>
        </div>
    `;
}

// Service Worker
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(() => {
        console.log('Service Worker enregistré');
    }).catch(err => {
        console.error('Erreur Service Worker:', err);
    });
}
// Navigation mois
function setupEventListeners() {
    document.getElementById('prevMonth').addEventListener('click', () => {
        currentDate.setMonth(currentDate.getMonth() - 1);
        renderCalendar();
    });
    
    document.getElementById('nextMonth').addEventListener('click', () => {
        currentDate.setMonth(currentDate.getMonth() + 1);
        renderCalendar();
    });
    
    document.getElementById('settingsBtn').addEventListener('click', () => {
        document.getElementById('settingsModal').classList.add('active');
    });
    
    document.getElementById('closeSettings').addEventListener('click', () => {
        document.getElementById('settingsModal').classList.remove('active');
    });
    
    document.getElementById('saveSettings').addEventListener('click', saveSettings);
    
    document.getElementById('resetData').addEventListener('click', resetData);
}

// Sauvegarder les paramètres
function saveSettings() {
    settings.coursePrice = parseFloat(document.getElementById('coursePrice').value) || 15;
    settings.studentName = document.getElementById('studentName').value;
    settings.teacherName = document.getElementById('teacherName').value;
    settings.userMode = document.getElementById('userMode').value;
    
    localStorage.setItem('paycourse_settings', JSON.stringify(settings));
    document.getElementById('settingsModal').classList.remove('active');
    
    renderCalendar();
    if (selectedDate) {
        renderDetail(selectedDate);
    }
    
    alert('Paramètres enregistrés !');
}

// Réinitialiser les données
function resetData() {
    if (confirm('Êtes-vous sûr de vouloir réinitialiser toutes les données ?')) {
        courseData = {};
        localStorage.removeItem('paycourse_data');
        
        if (window.db) {
            window.db.collection('courses').get().then(snapshot => {
                snapshot.forEach(doc => {
                    window.db.collection('courses').doc(doc.id).delete();
                });
            });
        }
        
        renderCalendar();
        document.getElementById('detailContent').innerHTML = '<p class="placeholder">Sélectionnez un jour</p>';
        document.getElementById('settingsModal').classList.remove('active');
    }
}

// Service Worker
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').then(reg => {
        console.log('Service Worker enregistré');
    }).catch(err => {
        console.error('Erreur Service Worker:', err);
    });
}
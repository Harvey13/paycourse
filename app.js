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

function formatEuro(amount) {
    return `${Number(amount || 0).toFixed(2)} €`;
}

function isSameAmount(left, right) {
    return Math.abs(Number(left || 0) - Number(right || 0)) < 0.005;
}

function buildPaymentExplanation(summary) {
    const price = Number(summary.prixCours || 0);
    const paid = Number(summary.montantSaisi || 0);
    const previousDebt = Number(summary.dettePrecedente || 0);
    const previousCredit = Math.max(0, Number(summary.soldeAvantCours || 0));
    const currentDue = Number(summary.montantCoursPaye || 0) + Number(summary.resteAPayer || 0);
    const totalDue = previousDebt + currentDue;
    const parts = [];

    if (isSameAmount(paid, price) && previousDebt === 0 && previousCredit === 0 && summary.excedent === 0 && summary.resteAPayer === 0) {
        return `Somme exacte: ${formatEuro(paid)} versés pour ${formatEuro(price)} dus.`;
    }

    if (previousDebt > 0) {
        parts.push(`Dette précédente de ${formatEuro(previousDebt)} ajoutée au cours de ${formatEuro(price)}, soit ${formatEuro(totalDue)} à régler.`);
    } else if (previousCredit > 0) {
        const consumedCredit = Math.min(previousCredit, price);
        parts.push(`Crédit précédent de ${formatEuro(previousCredit)} consommé à hauteur de ${formatEuro(consumedCredit)} sur le cours de ${formatEuro(price)}.`);
        parts.push(`Il restait donc ${formatEuro(currentDue)} à régler pour ce cours.`);
    } else {
        parts.push(`Cours dû: ${formatEuro(price)}.`);
    }

    if (paid === 0) {
        parts.push(`Aucun versement saisi.`);
    } else {
        parts.push(`${formatEuro(paid)} versés.`);
    }

    if (previousDebt > 0 && summary.montantDettePayee > 0) {
        parts.push(`${formatEuro(summary.montantDettePayee)} affectés à la dette précédente.`);
    }

    if (summary.montantCoursPaye > 0) {
        parts.push(`${formatEuro(summary.montantCoursPaye)} affectés au cours actuel.`);
    }

    if (summary.resteAPayer > 0) {
        parts.push(`Reste à payer: ${formatEuro(summary.resteAPayer)}.`);
    } else if (summary.excedent > 0) {
        parts.push(`Tout est réglé et ${formatEuro(summary.excedent)} deviennent un crédit pour un futur cours.`);
    } else if (isSameAmount(paid, price) && previousDebt === 0 && previousCredit === 0) {
        parts.push(`Somme exacte, rien à payer et rien en trop.`);
    } else {
        parts.push(`Tout est réglé, rien à payer.`);
    }

    return parts.join(' ');
}

function buildPaymentSummaryHtml(summary) {
    const debtExplanation = summary.dettePrecedente > 0
        ? `<br><strong>Reste à payer :</strong> ${formatEuro(summary.resteAPayer)} (${formatEuro(summary.prixCours)} + ${formatEuro(summary.dettePrecedente)} de dette précédente)`
        : summary.soldeAvantCours > 0
            ? `<br><strong>Crédit utilisé :</strong> ${formatEuro(Math.min(summary.soldeAvantCours, summary.prixCours))}`
            : '';

    const remainingExplanation = summary.resteAPayer > 0 && summary.dettePrecedente === 0
        ? `<br><strong>Reste à payer :</strong> ${formatEuro(summary.resteAPayer)}`
        : '';

    return `
        <strong>État :</strong> ${summary.etat}<br>
        <strong>Montant saisi :</strong> ${formatEuro(summary.montantSaisi)}${summary.excedent > 0 ? `<br><strong>Excédent :</strong> ${formatEuro(summary.excedent)}` : ''}${debtExplanation}${remainingExplanation}<br>
        <strong>Explication :</strong> ${summary.explication}
    `;
}

function getCourseSummaryPreview(dateStr, paidAmount) {
    const existing = courseData[dateStr] || {};
    return getCourseExportSummary(dateStr, {
        ...(existing || {}),
        exists: isCourseEntry(existing) || paidAmount > 0,
        paymentAmount: paidAmount
    });
}

function getCourseExportSummary(dateStr, data) {
    const paidAmount = Math.max(0, Number(data.paymentAmount ?? data.paidAmount ?? 0) || 0);
    const allocation = getAllocation(dateStr, paidAmount);
    const currentDue = Math.max(0, settings.coursePrice - Math.max(0, allocation.priorBalance));
    const totalDue = currentDue + allocation.previousDebt;

    let status = 'Non payé';
    let excess = 0;
    let remainingToPay = Math.max(0, totalDue - paidAmount);

    if (paidAmount > 0) {
        if (paidAmount > totalDue && !isSameAmount(paidAmount, totalDue)) {
            status = 'Payé intégralement + excédent';
            excess = paidAmount - totalDue;
            remainingToPay = 0;
        } else if (isSameAmount(paidAmount, totalDue)) {
            status = 'Payé intégralement';
            remainingToPay = 0;
        } else {
            status = 'Partiellement payé';
        }
    }

    const summary = {
        date: dateStr,
        etat: status,
        montantSaisi: paidAmount,
        excedent: excess,
        resteAPayer: remainingToPay,
        valide: Boolean(data.validated),
        prixCours: Number(settings.coursePrice || 0),
        dettePrecedente: allocation.previousDebt,
        montantDettePayee: allocation.debtPayment,
        montantCoursPaye: allocation.currentPayment,
        avoirFutur: allocation.credit,
        soldeAvantCours: allocation.priorBalance,
        cree: Boolean(data.exists || data.courseExists || data.createdAt || data.created),
        derniereMaj: data.timestamp || data.updated_at || data.createdAt || data.created || ''
    };

    return {
        ...summary,
        explication: buildPaymentExplanation(summary)
    };
}

function exportCourseAnalysis() {
    const startedAt = new Date();
    const allKeys = Object.keys(courseData || {});
    const courseKeys = allKeys
        .filter(key => isCourseEntry(courseData[key]))
        .sort();

    console.group('[PayCourse export] Export analyse cours');
    console.info('[PayCourse export] Démarrage', {
        at: startedAt.toISOString(),
        totalStoredKeys: allKeys.length,
        detectedCourses: courseKeys.length,
        coursePrice: settings.coursePrice,
        userMode: settings.userMode,
        storageBytes: localStorage.getItem('paycourse_data')?.length || 0,
        supabaseConfigured: Boolean(window.supabase && isSupabaseConfigured())
    });

    if (allKeys.length > 0 && courseKeys.length === 0) {
        console.warn('[PayCourse export] Des données existent, mais aucune entrée ne ressemble à un cours.', {
            keys: allKeys,
            sample: allKeys.slice(0, 5).map(key => ({ key, value: courseData[key] }))
        });
    }

    const rows = courseKeys.map(key => {
            const summary = getCourseExportSummary(key, courseData[key] || {});
            console.debug('[PayCourse export] Ligne préparée', { key, summary, raw: courseData[key] });
            return [
                summary.date,
                summary.etat,
                summary.prixCours.toFixed(2),
                summary.montantSaisi.toFixed(2),
                summary.excedent.toFixed(2),
                summary.resteAPayer.toFixed(2),
                summary.dettePrecedente.toFixed(2),
                summary.montantDettePayee.toFixed(2),
                summary.montantCoursPaye.toFixed(2),
                summary.avoirFutur.toFixed(2),
                summary.soldeAvantCours.toFixed(2),
                summary.explication,
                summary.valide ? 'Oui' : 'Non',
                summary.cree ? 'Oui' : 'Non',
                summary.derniereMaj
            ];
        });

    console.info('[PayCourse export] Lignes générées', rows.length);

    if (rows.length === 0) {
        console.warn('[PayCourse export] Export annulé: aucun cours à exporter.');
        console.groupEnd();
        alert('Aucun cours à exporter pour le moment.');
        return;
    }

    const headers = [
        'Date',
        'État',
        'Prix du cours (€)',
        'Montant saisi (€)',
        'Excédent (€)',
        'Reste à payer (€)',
        'Dette précédente (€)',
        'Dette payée (€)',
        'Cours payé (€)',
        'Avoir futur (€)',
        'Solde avant cours (€)',
        'Explication',
        'Validé',
        'Cours créé',
        'Dernière mise à jour'
    ];
    const csvContent = [headers, ...rows]
        .map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(','))
        .join('\n');

    try {
        const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const dateForFile = startedAt.toISOString().slice(0, 10);
        link.href = url;
        link.download = `analyse-cours-${dateForFile}.csv`;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
        console.info('[PayCourse export] Téléchargement demandé', {
            fileName: link.download,
            rows: rows.length,
            bytes: csvContent.length
        });
    } catch (error) {
        console.error('[PayCourse export] Erreur pendant la génération du fichier', error);
        alert('Échec de l’export. Vérifiez la console DevTools.');
    } finally {
        console.groupEnd();
    }
}

// Sauvegarder le paiement
async function savePayment(dateStr) {
    const paidAmount = parseFloat(document.getElementById('paidAmount').value) || 0;
    console.info('[PayCourse paiement] Validation du paiement', {
        date: dateStr,
        montantSaisi: paidAmount
    });
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

    console.info('[PayCourse init] Éléments paramètres', {
        settingsButtonFound: Boolean(settingsButton),
        exportButtonFound: Boolean(exportButton),
        saveSettingsButtonFound: Boolean(saveSettingsButton),
        resetButtonFound: Boolean(resetButton)
    });

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
    exportButton?.addEventListener('click', (event) => {
        event.preventDefault();
        console.info('[PayCourse export] Bouton cliqué', {
            targetId: event.currentTarget?.id,
            courseCount: Object.keys(courseData || {}).filter(key => isCourseEntry(courseData[key])).length
        });
        exportCourseAnalysis();
    });
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
    const summary = getCourseExportSummary(dateStr, data);

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

    html += `
        <div class="detail-summary" id="paymentSummary">
            ${buildPaymentSummaryHtml(summary)}
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
        html += `
            <div class="detail-row">
                <label>Montant versé :</label>
                <input type="number" id="paidAmount" value="${Number(data.paymentAmount || data.paidAmount || 0).toFixed(2)}" min="0" step="0.01" placeholder="Ex. 15">
            </div>
            <div class="breakdown" id="breakdown"></div>
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

    if (selectedDate) {
        const summary = getCourseSummaryPreview(selectedDate, paidAmount);
        const paymentSummary = document.getElementById('paymentSummary');
        if (paymentSummary) {
            paymentSummary.innerHTML = buildPaymentSummaryHtml(summary);
        }
        console.debug('[PayCourse paiement] Aperçu non enregistré', {
            date: selectedDate,
            montantSaisi: paidAmount,
            explication: summary.explication
        });
    }

    if (!breakdown) return;

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
    let serviceWorkerRefreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (serviceWorkerRefreshing) return;
        serviceWorkerRefreshing = true;
        window.location.reload();
    });

    navigator.serviceWorker.register('sw.js').then(registration => {
        console.log('Service Worker enregistré');
        registration.update();
    }).catch(err => {
        console.error('Erreur Service Worker:', err);
    });
}

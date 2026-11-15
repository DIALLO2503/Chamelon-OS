// Server-side words in the person's language (users.locale): module names and quick actions, the words they see on
// every screen. Keyed by the French catalog label; anything not listed stays in French. Vocabulary words chosen per
// country (Daret, Natt, Aman, NiYa…) are proper names and are not translated.
const WORDS = {
  ar: {
    'Accueil': 'الرئيسية', 'Compte': 'الحساب', 'Chantiers': 'الأوراش', 'Envois': 'التحويلات', 'Proches': 'الأقارب', 'Commandes': 'الطلبات',
    'Carnet': 'دفتر الكريدي', 'Factures': 'الفواتير', 'Gains': 'المداخيل', 'Budget': 'الميزانية', 'Float': 'السيولة', 'Messages': 'الرسائل',
    'Services': 'الخدمات', 'Encaisser': 'تحصيل', 'Avance': 'تسبيق',
    'Envoyer': 'إرسال', 'Recevoir': 'استلام', 'Paiement reçu': 'دفعة مستلمة', 'Paiement fait': 'دفعة منجزة', 'Payer un code': 'دفع رمز',
    'Retirer': 'سحب', 'Retrait chez un agent': 'سحب عند وكيل', 'Payer une facture': 'أداء فاتورة', 'Demande de paiement': 'طلب دفع',
    'Nouveau chantier': 'ورش جديد', 'Demander un acompte': 'طلب تسبيق', 'Bloquer des fonds': 'حجز الأموال', 'Valider une étape': 'تأكيد مرحلة',
    'Noter un crédit': 'تسجيل كريدي', 'Facture fournisseur': 'فاتورة المورد', 'Course': 'رحلة', 'Dépense': 'مصروف', 'Dépôt client': 'إيداع زبون',
    'Retrait client': 'سحب زبون', 'Envoyer au pays': 'إرسال إلى البلد', 'Programmer': 'برمجة', 'Ajouter un proche': 'إضافة قريب', 'Cotiser': 'المساهمة',
    'Payer l’équipe': 'أداء أجور الفريق', 'Objectif du mois': 'هدف الشهر', 'Nouveau groupe': 'مجموعة جديدة',
  },
  en: {
    'Accueil': 'Home', 'Compte': 'Account', 'Chantiers': 'Jobs', 'Envois': 'Transfers', 'Proches': 'Family', 'Commandes': 'Orders',
    'Carnet': 'Credit book', 'Factures': 'Invoices', 'Gains': 'Earnings', 'Budget': 'Budget', 'Float': 'Float', 'Messages': 'Messages',
    'Services': 'Services', 'Encaisser': 'Collect', 'Avance': 'Advance',
    'Envoyer': 'Send', 'Recevoir': 'Receive', 'Paiement reçu': 'Payment received', 'Paiement fait': 'Payment made', 'Payer un code': 'Pay a code',
    'Retirer': 'Withdraw', 'Retrait chez un agent': 'Cash out at an agent', 'Payer une facture': 'Pay a bill', 'Demande de paiement': 'Payment request',
    'Nouveau chantier': 'New job', 'Demander un acompte': 'Request a deposit', 'Bloquer des fonds': 'Hold funds', 'Valider une étape': 'Approve a stage',
    'Noter un crédit': 'Record a credit', 'Facture fournisseur': 'Supplier invoice', 'Course': 'Trip', 'Dépense': 'Expense', 'Dépôt client': 'Customer deposit',
    'Retrait client': 'Customer withdrawal', 'Envoyer au pays': 'Send home', 'Programmer': 'Schedule', 'Ajouter un proche': 'Add a relative', 'Cotiser': 'Contribute',
    'Payer l’équipe': 'Pay the crew', 'Objectif du mois': 'Monthly goal', 'Nouveau groupe': 'New group',
  },
}
export const LOCALES = ['fr', 'ar', 'en']
export const tr = (text, locale) => (text && WORDS[locale]?.[text]) ?? text

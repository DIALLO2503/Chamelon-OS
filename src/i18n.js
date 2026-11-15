// Interface language: French (default), Arabic (right to left) and English. The choice is kept on the device and on the
// account (users.locale), so the server translates module names and quick actions too. Words not yet translated fall
// back to French rather than showing a key.
const DICT = {
  ar: {
    'Votre numéro de téléphone': 'رقم هاتفك',
    'Nous vous envoyons un code pour vérifier que c’est bien vous.': 'سنرسل لك رمزًا للتحقق من هويتك.',
    'Recevoir le code': 'استلام الرمز',
    'Comptes de démonstration': 'حسابات تجريبية',
    'Entrez le code': 'أدخل الرمز',
    'Valider': 'تأكيد',
    'Changer de numéro': 'تغيير الرقم',
    'Votre code secret': 'رمزك السري',
    'Code secret oublié ?': 'نسيت الرمز السري؟',
    'Services': 'الخدمات',
    'Votre profil': 'ملفك الشخصي',
    'Passer à ce profil': 'الانتقال إلى هذا الملف',
    'Confirmer': 'تأكيد',
    'Changer de compte': 'تغيير الحساب',
    'Se déconnecter': 'تسجيل الخروج',
    'Langue': 'اللغة',
    'Fermer': 'إغلاق',
    'Modifier': 'تعديل',
    'Terminé': 'تم',
    'Enregistrer': 'حفظ',
    'Voir le récapitulatif': 'عرض الملخص',
    'Ce récapitulatif est valable 10 minutes.': 'هذا الملخص صالح لمدة 10 دقائق.',
    'Hors ligne · lecture seule': 'غير متصل · للقراءة فقط',
    'Console d’administration': 'لوحة الإدارة',
    'À débloquer': 'للفتح لاحقًا',
  },
  en: {
    'Votre numéro de téléphone': 'Your phone number',
    'Nous vous envoyons un code pour vérifier que c’est bien vous.': 'We send you a code to check it is really you.',
    'Recevoir le code': 'Get the code',
    'Comptes de démonstration': 'Demo accounts',
    'Entrez le code': 'Enter the code',
    'Valider': 'Confirm',
    'Changer de numéro': 'Change number',
    'Votre code secret': 'Your secret code',
    'Code secret oublié ?': 'Forgot your secret code?',
    'Services': 'Services',
    'Votre profil': 'Your profile',
    'Passer à ce profil': 'Switch to this profile',
    'Confirmer': 'Confirm',
    'Changer de compte': 'Switch account',
    'Se déconnecter': 'Sign out',
    'Langue': 'Language',
    'Fermer': 'Close',
    'Modifier': 'Edit',
    'Terminé': 'Done',
    'Enregistrer': 'Save',
    'Voir le récapitulatif': 'Review',
    'Ce récapitulatif est valable 10 minutes.': 'This review is valid for 10 minutes.',
    'Hors ligne · lecture seule': 'Offline · read only',
    'Console d’administration': 'Admin console',
    'À débloquer': 'To unlock',
  },
}
export const LANGS = [['fr', 'Français'], ['ar', 'العربية'], ['en', 'English']]
const RTL = new Set(['ar'])

let lang = (() => { try { return localStorage.getItem('nexus_lang') || 'fr' } catch { return 'fr' } })()
export const currentLang = () => lang
export const t = text => DICT[lang]?.[text] ?? text

// Sets the language and direction of the whole page; callers re-render (the app reloads its screens).
export function setLang(next) {
  lang = DICT[next] || next === 'fr' ? next : 'fr'
  try { localStorage.setItem('nexus_lang', lang) } catch {}
  document.documentElement.lang = lang
  document.documentElement.dir = RTL.has(lang) ? 'rtl' : 'ltr'
}
setLang(lang)

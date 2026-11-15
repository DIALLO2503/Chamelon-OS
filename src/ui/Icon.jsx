// Static imports: icons are bundled and cached with the app, so they work offline and on slow networks.
import {
  ArrowDownLeft, ArrowLeftRight, ArrowUpRight, BadgeCheck, Banknote, Bell, Building2, CalendarClock, CalendarDays, TrendingDown, Camera, Car, Check, ChevronLeft, ChevronRight,
  CircleCheck, CircleHelp, Clock, Coins, Copy, Fuel, Gauge, Globe, GraduationCap, Hammer, HardHat, HeartHandshake, House, IdCard, Landmark,
  LayoutGrid, Link, LoaderCircle, LogOut, Minus, NotebookPen, Package, PiggyBank, Plus, QrCode, ReceiptText, RotateCcw, Search, Share2, ShieldCheck,
  Ship, ShoppingBag, Store, TrendingUp, TriangleAlert, UserRoundPlus, UsersRound, Wallet, Wrench, X, Delete, Lock, MessageCircle, Briefcase, Send, Eye, EyeOff, Download,
} from 'lucide-react'

const ICONS = {
  download: Download,
  'arrow-down-left': ArrowDownLeft, 'arrow-left-right': ArrowLeftRight, 'arrow-up-right': ArrowUpRight, 'badge-check': BadgeCheck, banknote: Banknote,
  bell: Bell, 'building-2': Building2, 'calendar-clock': CalendarClock, 'calendar-days': CalendarDays, 'trending-down': TrendingDown, camera: Camera, car: Car, check: Check, 'chevron-left': ChevronLeft, 'chevron-right': ChevronRight,
  'circle-check': CircleCheck, 'circle-help': CircleHelp, clock: Clock, coins: Coins, copy: Copy, fuel: Fuel, gauge: Gauge, globe: Globe, 'graduation-cap': GraduationCap,
  hammer: Hammer, 'hard-hat': HardHat, 'heart-handshake': HeartHandshake, house: House, 'id-card': IdCard, landmark: Landmark, 'layout-grid': LayoutGrid, link: Link,
  'loader-circle': LoaderCircle, 'log-out': LogOut, minus: Minus, 'notebook-pen': NotebookPen, package: Package, 'piggy-bank': PiggyBank, plus: Plus, 'qr-code': QrCode,
  'receipt-text': ReceiptText, 'rotate-ccw': RotateCcw, search: Search, share: Share2, 'shield-check': ShieldCheck, ship: Ship, 'shopping-bag': ShoppingBag, store: Store,
  'trending-up': TrendingUp, 'triangle-alert': TriangleAlert, 'user-round-plus': UserRoundPlus, 'users-round': UsersRound, wallet: Wallet, wrench: Wrench, x: X,
  delete: Delete, lock: Lock, whatsapp: MessageCircle, briefcase: Briefcase, send: Send, eye: Eye, 'eye-off': EyeOff,
}

export default function Icon({ name, size = 20 }) {
  const C = ICONS[name] ?? CircleHelp
  return <C size={size} strokeWidth={1.75} aria-hidden="true" style={{ flex: 'none' }} />
}

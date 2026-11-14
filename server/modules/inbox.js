import { all } from '../db.js'
import { ago } from '../core.js'
import { rowsBlock } from '../context.js'

export default {
  async view(ctx) {
    const rows = (await all(ctx.client, 'SELECT * FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [ctx.user.id]))
      .map(n => ({ id: String(n.id), title: n.text, sub: ago(n.created_at), icon: 'bell', ...(n.read_at ? {} : { status: 'Nouveau', tone: 'wait' }) }))
    return { blocks: [rowsBlock('Messages', 'bell', rows, 'Aucun message pour le moment.')], actions: ['readAll'] }
  },
  actions: {
    readAll: {
      label: 'Tout marquer comme lu', icon: 'check',
      form: () => ({ title: 'Tout marquer comme lu', fields: [] }),
      async run(ctx) { await ctx.client.query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [ctx.user.id]); return { message: 'Messages marqués comme lus' } },
    },
  },
}

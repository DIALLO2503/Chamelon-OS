import pino from 'pino'
import { config } from './config.js'

export const log = pino({ level: config.env === 'test' ? 'silent' : 'info', redact: ['req.headers.authorization', 'req.headers.cookie', '*.pin', '*.code'] })

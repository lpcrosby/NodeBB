

import winston = require('winston');

import user = require('../user');
import notifications = require('../notifications');
import sockets = require('../socket.io');
import plugins = require('../plugins');
import meta = require('../meta');
import { Messaging } from '.';

export default function Messaging() {
    let notifyQueue: NonNullable<unknown>; // Only used to notify a user of a new chat message, see Messaging.notifyUser

    async function notifyUsersInRoom(this: Messaging, fromUid: string, roomId: string, messageObj: any): Promise<void> {
        let uids: string[] = await this.getUidsInRoom(roomId, 0, -1);
        uids = await user.blocks.filterUids(fromUid, uids);

        let data = {
            roomId: roomId,
            fromUid: fromUid,
            message: messageObj,
            uids: uids,
        };

        data = await plugins.hooks.fire('filter:messaging.notify', data);
        if (!data || !data.uids || !data.uids.length) {
            return;
        }

        uids = data.uids;
        const isSenderSameAsRecipient = (recipientUid: string) => parseInt(recipientUid, 10) === parseInt(fromUid, 10);

        uids.forEach(function(uid: string) {
            this.pushUnreadCount(uid);
            sockets.in('uid_' + uid).emit('event:chats.receive', Object.assign({}, data, {
                self: this.isSenderSameAsRecipient(uid) ? 1 : 0
            }));
        });

        if (messageObj.system) {
            return;
        }
        // Delayed notifications
        let queueObj = this.notifyQueue[`${fromUid}:${roomId}`];
        if (queueObj) {
            queueObj.message.content += `\n${messageObj.content}`;
            clearTimeout(queueObj.timeout);
        } else {
            queueObj = {
                message: messageObj,
            };
            this.notifyQueue[`${fromUid}:${roomId}`] = queueObj;
        }

        queueObj.timeout = setTimeout(async () => {
            try {
                await this.sendNotifications(fromUid, uids, roomId, queueObj.message);
            } catch (err) {
                winston.error(`[messaging/notifications] Unabled to send notification\n${err.stack}`);
            }
        }, meta.config.notificationSendDelay * 1000);
    }

    async function sendNotifications(fromUid: string, uids: string[], roomId: string, messageObj: any): Promise<void> {
        const isOnline = await user.isOnline(uids);
        uids = uids.filter((uid: string, index: number) => !isOnline[index] && parseInt(fromUid, 10) !== parseInt(uid, 10));
        if (!uids.length) {
            return;
        }

        const { displayname } = messageObj.fromUser;

        const isGroupChat = await this.isGroupChat(roomId);
        const notification = await notifications.create({
            type: isGroupChat ? 'new-group-chat' : 'new-chat',
            subject: `[[email:notif.chat.subject, ${displayname}]]`,
            bodyShort: `[[notifications:new_message_from, ${displayname}]]`,
            bodyLong: messageObj.content,
            nid: `chat_${fromUid}_${roomId}`,
            from: fromUid,
            path: `/chats/${messageObj.roomId}`,
        });

        delete this.notifyQueue[`${fromUid}:${roomId}`];
        notifications.push(notification, uids);
    }
}

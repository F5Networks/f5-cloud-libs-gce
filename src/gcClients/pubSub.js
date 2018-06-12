/**
* Copyright 2018 F5 Networks, Inc.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
*     http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/

'use strict';

const assert = require('assert');
const q = require('q');
const Logger = require('@f5devcentral/f5-cloud-libs').logger;
const httpUtil = require('@f5devcentral/f5-cloud-libs').httpUtil;
const cloudUtil = require('@f5devcentral/f5-cloud-libs').util;

const BASE_URL = 'https://pubsub.googleapis.com/v1';

/**
 * Constructor
 *
 * @class
 * @classdesc
 * The Google cloud node SDK PubSub client version 0.18 causes node to crash
 * when calling getTopics. This class mimics that client.
 *
 * @param {String} serviceAccount          - The name of the service account to use.
 * @param {Object} [options.loggerOptions] - Options for the logger.
 */
function PubSub(serviceAccount, options) {
    assert.equal(typeof serviceAccount, 'string', 'serviceAccount is required for PubSub');

    const loggerOptions = options.loggerOptions;

    this.initialized = false;
    this.serviceAccount = serviceAccount;
    if (loggerOptions) {
        loggerOptions.module = module;
        this.logger = Logger.getLogger(loggerOptions);
        cloudUtil.setLoggerOptions(loggerOptions);
    }
}

PubSub.prototype.acknowledge = function acknowledge(subscription, ackIds) {
    assert.equal(typeof subscription, 'string', 'subscription is required for PubSub.acknowledge');
    assert.equal(typeof ackIds, 'object', 'ackIds is required for PubSub.acknowledge');

    if (ackIds.length > 0) {
        return initialize.call(this)
            .then(() => {
                const body = {
                    ackIds
                };
                return sendRequest.call(this, 'POST', `subscriptions/${subscription}:acknowledge`, body);
            })
            .catch((err) => {
                logError.call(this, 'acknowledge', err);
            });
    }
    return q();
};

PubSub.prototype.createTopic = function createTopic(name) {
    assert.equal(typeof name, 'string', 'topic name is required for PubSub.createTopic');

    return initialize.call(this)
        .then(() => {
            return sendRequest.call(this, 'PUT', `topics/${name}`);
        })
        .catch((err) => {
            logError.call(this, 'createTopic', err);
        });
};

PubSub.prototype.createSubscription = function createSubscription(topicName, subscriptionName, options) {
    assert.equal(
        typeof subscriptionName,
        'string',
        'subscription name is required for PubSub.createSubscription'
    );

    return initialize.call(this)
        .then(() => {
            const body = {
                topic: `projects/${this.projectId}/topics/${topicName}`,
                messageRetentionDuration: options ? options.messageRetentionDuration : null
            };
            return sendRequest.call(this, 'PUT', `subscriptions/${subscriptionName}`, body);
        })
        .catch((err) => {
            logError.call(this, 'createSubscription', err);
        });
};

/**
 * Gets the subscriptions for a given topic
 *
 * @param {Object} params       - Dictionary of parameters
 * @param {String} params.topic - Full name of topic
 *
 * @returns {Promise} A promise which is resolved with an array where
 *                    the first element contains the subscriptions
 *                    for the topic.
 */
PubSub.prototype.getSubscriptions = function getSubscriptions(params) {
    assert.equal(typeof params.topic, 'string', 'topic is required for PubSub.getSubscriptions');

    return initialize.call(this)
        .then(() => {
            return sendRequest.call(this, 'GET', `topics/${params.topic}/subscriptions`);
        })
        .then((data) => {
            const subscriptions = data.subscriptions || [];
            return [subscriptions];
        })
        .catch((err) => {
            logError.call(this, 'getSubscriptions', err);
        });
};

/**
 * Gets the topics for the current project
 *
 * @returns {Promise} A promise which is resolved with an array where
 *                    the first element contains the topics
 *                    for the project.
 */
PubSub.prototype.getTopics = function getTopics() {
    return initialize.call(this)
        .then(() => {
            return sendRequest.call(this, 'GET', 'topics');
        })
        .then((data) => {
            const topics = data.topics || [];
            return [topics];
        })
        .catch((err) => {
            logError.call(this, 'getTopics', err);
        });
};

/**
 * Publishes a message to a topic
 *
 * @param {String}          topic   - Full name of topic to publish to
 * @param {String | Object} message - Message to publish.
 *
 * @returns {Promise} A promise which is resolved when the request completes
 *                    or is rejected if an error occurs.
 */
PubSub.prototype.publish = function publish(topic, message) {
    return initialize.call(this)
        .then(() => {
            let messageData;
            let contentType;

            if (typeof message === 'string') {
                messageData = message;
                contentType = 'text/plain';
            } else {
                messageData = JSON.stringify(message);
                contentType = 'application/json';
            }
            const body = {
                messages: [
                    {
                        data: Buffer.from(messageData, 'utf8').toString('base64'),
                        attributes: { contentType }
                    }
                ]
            };
            return sendRequest.call(this, 'POST', `topics/${topic}:publish`, body);
        })
        .catch((err) => {
            logError.call(this, 'publish', err);
        });
};

/**
 * Pulls a subscription for messages
 *
 * @param {String} subscription - Full name of subscription to pull from
 *
 * @returns {Promise} A promise which is resolved when the request completes
 *                    or is rejected if an error occurs.
 */
PubSub.prototype.pull = function pull(subscription) {
    const messages = [];

    return initialize.call(this)
        .then(() => {
            const body = {
                returnImmediately: true,
                maxMessages: 10
            };
            return sendRequest.call(this, 'POST', `subscriptions/${subscription}:pull`, body);
        })
        .then((data) => {
            const receivedMessages = data.receivedMessages || [];
            const ackIds = [];
            receivedMessages.forEach((receivedMessage) => {
                const contentType = receivedMessage.message.attributes.contentType;
                const messageString = Buffer.from(receivedMessage.message.data, 'base64').toString('utf8');
                ackIds.push(receivedMessage.ackId);

                let message;
                if (contentType === 'application/json') {
                    try {
                        message = JSON.parse(messageString);
                    } catch (err) {
                        this.logger.info(
                            'JSON parse failure receiving pubsub message',
                            err && err.message ? err.message : err
                        );
                    }
                } else {
                    message = messageString;
                }
                messages.push(message);
            });
            return this.acknowledge(subscription, ackIds);
        })
        .then(() => {
            return q(messages);
        })
        .catch((err) => {
            logError.call(this, 'pull', err);
        });
};

function initialize() {
    if (this.initialized) {
        return q();
    }

    return getMetadata.call(this, 'project/project-id')
        .then((projectId) => {
            this.projectId = projectId;
            return getMetadata.call(this, `instance/service-accounts/${this.serviceAccount}/token`);
        })
        .then((token) => {
            this.accessToken = token.access_token;
            this.initialized = true;
            return q();
        })
        .catch((err) => {
            logError.call(this, 'init', err);
        });
}

function sendRequest(method, path, body) {
    if (!this.accessToken) {
        return q.reject(new Error('httpUtil.sendRequest: no auth token. call init first'));
    }
    const headers = {
        Authorization: `Bearer ${this.accessToken}`,
        'Content-Type': 'application/json'
    };

    const url = `${BASE_URL}/projects/${this.projectId}/${path}`;

    return httpUtil.request(method, url, { headers, body });
}

function logError(funcName, err) {
    if (this.logger) {
        this.logger.info(`${funcName} error: ${err && err.message ? err.message : err}`);
    }
}

/**
 * Queries local metadata service for an entry
 *
 * @param {String} entry - The name of the metadata entry. For example 'insance/zone'
 *
 * @returns {Promise} A promise which is resolved with the data or rejected if an
 *                    error occurs.
 */
function getMetadata(entry) {
    const options = {
        headers: {
            'Metadata-Flavor': 'Google'
        }
    };

    return cloudUtil.getDataFromUrl(
        `http://metadata.google.internal/computeMetadata/v1/${entry}`,
        options
    )
        .then((data) => {
            return data;
        })
        .catch((err) => {
            const message = `Error getting metadata ${err.message}`;
            this.logger.info(message);
            return q.reject(err);
        });
}

module.exports = PubSub;

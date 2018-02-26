/**
 * Copyright 2016-2018 F5 Networks, Inc.
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

let GceAutoscaleProvider;
let provider;

// Our tests cause too many event listeners. Turn off the check.
process.setMaxListeners(0);

module.exports = {
    setUp(callback) {
        // eslint-disable-next-line global-require
        GceAutoscaleProvider = require('../../lib/gceAutoscaleProvider');
        provider = new GceAutoscaleProvider();

        callback();
    },

    tearDown(callback) {
        Object.keys(require.cache).forEach((key) => {
            delete require.cache[key];
        });
        callback();
    },

    testGetNicsByTag: {
        testBasic(test) {
            test.expect(1);
            provider.getNicsByTag('foo')
                .then((response) => {
                    test.strictEqual(response.length, 0);
                })
                .catch((err) => {
                    test.ok(false, err.message);
                })
                .finally(() => {
                    test.done();
                });
        }
    },

    testGetVmsByTag: {
        testBasic(test) {
            const myTag = {
                key: 'foo',
                value: 'bar'
            };
            const vmId = 'vm1';
            const privateIp = '1.2.3.4';
            const publicIp = '5.6.7.8';
            const region = '1234';

            let passedOptions;

            provider.region = region;

            provider.compute.getVMs = function getVMs(options) {
                passedOptions = options;
                return new Promise((resolve) => {
                    resolve([[
                        {
                            id: vmId,
                            zone: {
                                id: `${region}-a`
                            },
                            metadata: {
                                networkInterfaces: [
                                    {
                                        networkIP: privateIp,
                                        accessConfigs: [
                                            {
                                                natIP: publicIp
                                            }
                                        ]
                                    }
                                ]
                            }
                        }
                    ]]);
                });
            };

            test.expect(2);
            provider.getVmsByTag(myTag)
                .then((response) => {
                    test.deepEqual(passedOptions, { filter: `labels.${myTag.key} eq ${myTag.value}` });
                    test.deepEqual(
                        response[0],
                        {
                            id: vmId,
                            ip: {
                                public: publicIp,
                                private: privateIp
                            }
                        }
                    );
                })
                .catch((err) => {
                    test.ok(false, err.message);
                })
                .finally(() => {
                    test.done();
                });
        },

        testNoResults(test) {
            const myTag = {
                key: 'foo',
                value: 'bar'
            };

            provider.compute.getVMs = function getVms() {
                return new Promise((resolve) => {
                    resolve([[]]);
                });
            };

            test.expect();
            provider.getVmsByTag(myTag)
                .then((response) => {
                    test.strictEqual(response.length, 0);
                })
                .catch((err) => {
                    test.ok(false, err.message);
                })
                .finally(() => {
                    test.done();
                });
        },

        testBadTag(test) {
            const myTag = 'foo';

            test.expect(1);
            provider.getVmsByTag(myTag)
                .then(() => {
                    test.ok(false, 'getVmsByTag should have thrown');
                })
                .catch((err) => {
                    test.notStrictEqual(err.message.indexOf('key and value'), -1);
                })
                .finally(() => {
                    test.done();
                });
        },

        testError(test) {
            const myTag = {
                key: 'foo',
                value: 'bar'
            };

            provider.compute.getVMs = function getVms() {
                return new Promise((resolve, reject) => {
                    reject(new Error('uh oh'));
                });
            };

            test.expect(1);
            provider.getVmsByTag(myTag)
                .then(() => {
                    test.ok(false, 'getVmsByTag should have thrown');
                })
                .catch((err) => {
                    test.strictEqual(err.message, 'uh oh');
                })
                .finally(() => {
                    test.done();
                });
        }
    }
};

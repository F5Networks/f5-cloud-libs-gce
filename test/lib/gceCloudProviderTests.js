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

const q = require('q');

const region = 'aRegion';
const clientId = 'aClient';
const projectId = 'aProject';
const credentials = {
    foo: 'bar'
};

const instanceId = 'this_is_my_instance_id';

const vm1 = {
    name: 'vm1',
    metadata: {
        status: 'RUNNING',
    },
    getMetadata() {
        return q(
            [{
                networkInterfaces: [
                    {
                        networkIP: '1.2.3.4',
                        accessConfigs: [
                            {
                                natIP: '5.6.7.8'
                            }
                        ]
                    }
                ]
            }]
        );
    }
};

const instance1 = {
    id: 'vm1',
    isMaster: false
};

let CloudProvider;
let GceCloudProvider;
let provider;

let cloudUtilMock;
let computeMock;
let fsMock;

let createReadStream;

const passedParams = {
    storage: {},
    storageBucket: {
        fileDeleteParams: []
    }
};
let storageBucketFileDeleteCalled = false;

const vmSetTagsParams = {};

// Our tests cause too many event listeners. Turn off the check.
process.setMaxListeners(0);

module.exports = {
    setUp(callback) {
        /* eslint-disable global-require */
        cloudUtilMock = require('@f5devcentral/f5-cloud-libs').util;
        computeMock = require('@google-cloud/compute');

        fsMock = require('fs');

        CloudProvider = require('@f5devcentral/f5-cloud-libs').cloudProvider;
        GceCloudProvider = require('../../lib/gceCloudProvider');
        /* eslint-enable global-require */

        provider = new GceCloudProvider();
        provider.compute = {};

        cloudUtilMock.getDataFromUrl = function getDataFromUrl(url) {
            if (url.endsWith('instance/zone')) {
                return q(`projects/734288666861/zones/${region}-a`);
            } else if (url.endsWith('instance/name')) {
                return q(instanceId);
            } else if (url.endsWith('project/project-id')) {
                return q(projectId);
            }

            return q();
        };
        createReadStream = fsMock.createReadStream;

        callback();
    },

    tearDown(callback) {
        Object.keys(require.cache).forEach((key) => {
            delete require.cache[key];
        });
        fsMock.createReadStream = createReadStream;
        callback();
    },

    testInit: {
        testCredentials(test) {
            const secretBase64 = cloudUtilMock.createBufferFrom(
                JSON.stringify(credentials)
            ).toString('base64');
            const providerOptions = {
                clientId,
                projectId,
                secret: secretBase64,
                region: 'east'
            };
            provider.init(providerOptions)
                .then(() => {
                    test.deepEqual(provider.compute.authClient.config.credentials, credentials);
                })
                .catch((err) => {
                    test.ok(false, err);
                })
                .finally(() => {
                    test.done();
                });
        },

        testCredentialsNoRegion(test) {
            const secretBase64 = cloudUtilMock.createBufferFrom(
                JSON.stringify(credentials)
            ).toString('base64');
            const providerOptions = {
                clientId,
                projectId,
                secret: secretBase64
            };
            provider.init(providerOptions)
                .then(() => {
                    test.ok(false, 'Should have thrown no region');
                })
                .catch((err) => {
                    test.notStrictEqual(err.message.indexOf('region is required'), -1);
                })
                .finally(() => {
                    test.done();
                });
        },

        testNoCredentials(test) {
            const providerOptions = { region };
            provider.init(providerOptions)
                .then(() => {
                    test.strictEqual(provider.region, region);
                })
                .catch((err) => {
                    test.ok(false, err);
                })
                .finally(() => {
                    test.done();
                });
        },

        testNoCredentialsNoRegion(test) {
            const providerOptions = {};
            provider.init(providerOptions)
                .then(() => {
                    test.strictEqual(provider.region, region);
                })
                .catch((err) => {
                    test.ok(false, err);
                })
                .finally(() => {
                    test.done();
                });
        },

        testStorageBucketNoCredentials(test) {
            const storageBucket = 'gcp-storage-bucket';
            const providerOptions = { storageBucket };
            provider.init(providerOptions)
                .then(() => {
                    test.strictEqual(provider.region, region);
                    test.strictEqual(provider.storageBucket.name, storageBucket);
                })
                .catch((err) => {
                    test.ok(false, err);
                })
                .finally(() => {
                    test.done();
                });
        }
    },

    testGetDataFromUri: {
        setUp(callback) {
            provider.storage = {
                bucket(bucketParams) {
                    passedParams.storage.bucketParams = bucketParams;
                    return {
                        file(fileParams) {
                            passedParams.storage.fileParams = fileParams;
                            return {
                                download() {
                                    return q(['{"key":"value"}']);
                                },
                                getMetadata() {
                                    return q([{ contentType: 'application/json' }]);
                                }
                            };
                        }
                    };
                }
            };
            callback();
        },

        testBasic(test) {
            test.expect(3);
            provider.getDataFromUri('gs://myBucket/myFilename')
                .then((data) => {
                    test.strictEqual(passedParams.storage.bucketParams, 'myBucket');
                    test.strictEqual(passedParams.storage.fileParams, 'myFilename');
                    test.strictEqual(data.key, 'value');
                })
                .catch((err) => {
                    test.ok(false, err);
                })
                .finally(() => {
                    test.done();
                });
        },

        testComplexKey(test) {
            test.expect(3);
            provider.getDataFromUri('gs://myBucket/myFolder/myFilename')
                .then((data) => {
                    test.strictEqual(passedParams.storage.bucketParams, 'myBucket');
                    test.strictEqual(passedParams.storage.fileParams, 'myFolder/myFilename');
                    test.strictEqual(data.key, 'value');
                })
                .catch((err) => {
                    test.ok(false, err);
                })
                .finally(() => {
                    test.done();
                });
        },

        testInvalidUri(test) {
            test.expect(1);
            provider.getDataFromUri('https://console.cloud.google.com/storage/browser/bucket/key')
                .then(() => {
                    test.ok(false, 'Should have thrown invalid URI');
                })
                .catch((err) => {
                    test.notStrictEqual(err.message.indexOf('Invalid URI'), -1);
                })
                .finally(() => {
                    test.done();
                });
        },

        testInvalidArn(test) {
            test.expect(1);
            provider.getDataFromUri('gs://myBucket/')
                .then(() => {
                    test.ok(false, 'Should have thrown invalid URI');
                })
                .catch((err) => {
                    test.notStrictEqual(err.message.indexOf('Invalid URI'), -1);
                })
                .finally(() => {
                    test.done();
                });
        }
    },

    testUCSFunctions: {
        setUp(cb) {
            provider.storageBucket = {
                file(fileName) {
                    passedParams.storageBucket.fileParams = fileName;
                    return {
                        save(dataToWrite) {
                            passedParams.storageBucket.fileSaveParams = dataToWrite;
                            return q();
                        },
                        delete() {
                            storageBucketFileDeleteCalled = true;
                            passedParams.storageBucket.fileDeleteParams.push(fileName);
                            return q();
                        }
                    };
                },
                getFiles(options) {
                    passedParams.storageBucket.getFiles = options;
                    return q(
                        [
                            [
                                {
                                    getMetadata() {
                                        return [
                                            {
                                                name: 'backup/ucsAutosave_123.ucs',
                                                updated: '2019-01-01T18:22:10.102Z'
                                            }
                                        ];
                                    }
                                },
                                {
                                    getMetadata() {
                                        return [
                                            {
                                                name: 'backup/ucsAutosave_234.ucs',
                                                updated: '2019-01-02T18:22:10.102Z'
                                            }
                                        ];
                                    }
                                },
                                {
                                    getMetadata() {
                                        return [
                                            {
                                                name: 'backup/ucsAutosave_345.ucs',
                                                updated: '2019-01-03T18:22:10.102Z'
                                            }
                                        ];
                                    }
                                },
                                {
                                    getMetadata() {
                                        return [
                                            {
                                                name: 'backup/ucsAutosave_456.ucs',
                                                updated: '2019-01-04T18:22:10.102Z'
                                            }
                                        ];
                                    }
                                }
                            ],
                        ]
                    );
                }
            };

            fsMock.createReadStream = () => {
                return 'string data';
            };

            cb();
        },

        testDeleteStoredUcs(test) {
            storageBucketFileDeleteCalled = false;
            test.expect(2);
            provider.deleteStoredUcs('foo.ucs')
                .then(() => {
                    test.ok(storageBucketFileDeleteCalled);
                    test.strictEqual(passedParams.storageBucket.fileDeleteParams[0], 'backup/foo.ucs');
                })
                .catch((err) => {
                    test.ok(false, err.message);
                })
                .finally(() => {
                    test.done();
                });
        },

        testStoreUCS(test) {
            const ucsFileName = 'ucsAutosave_123.ucs';
            const ucsFilePath = `/var/local/ucs/${ucsFileName}`;

            test.expect(3);
            provider.storeUcs(ucsFilePath, 7, 'ucsAutosave_')
                .then(() => {
                    test.strictEqual(passedParams.storageBucket.fileParams, `backup/${ucsFileName}`);
                    test.strictEqual(passedParams.storageBucket.fileSaveParams, 'string data');
                    test.strictEqual(storageBucketFileDeleteCalled, false);
                })
                .catch((err) => {
                    test.ok(false, err.message);
                })
                .finally(() => {
                    test.done();
                });
        },

        testStoreUCSDeleteOldestObjects(test) {
            const ucsFileName = 'ucsAutosave_123.ucs';
            const ucsFilePath = `/var/local/ucs/${ucsFileName}`;

            test.expect(3);
            provider.storeUcs(ucsFilePath, 2, 'ucsAutosave_')
                .then(() => {
                    test.deepEqual(passedParams.storageBucket.getFiles, { prefix: 'backup/' });
                    test.deepEqual(
                        passedParams.storageBucket.fileDeleteParams,
                        ['backup/ucsAutosave_123.ucs', 'backup/ucsAutosave_234.ucs']
                    );
                    test.strictEqual(storageBucketFileDeleteCalled, true);
                })
                .catch((err) => {
                    test.ok(false, err.message);
                })
                .finally(() => {
                    test.done();
                });
        },

        tearDown(cb) {
            storageBucketFileDeleteCalled = false;
            passedParams.storageBucket.fileDeleteParams = [];
            cb();
        }
    },

    testElectMaster: {
        testBasic(test) {
            const instances = {
                1: {
                    privateIp: '1.2.3.4',
                    versionOk: true,
                    providerVisible: true
                },
                2: {
                    privateIp: '2.3.4.5',
                    versionOk: true,
                    providerVisible: true
                }
            };

            test.expect(1);
            provider.electMaster(instances)
                .then((response) => {
                    test.strictEqual(response, '1');
                })
                .catch((err) => {
                    test.ok(false, err.message);
                })
                .finally(() => {
                    test.done();
                });
        },

        testProviderNotVisible(test) {
            const instances = {
                1: {
                    privateIp: '1.2.3.4',
                    versionOk: true,
                    providerVisible: false
                },
                2: {
                    privateIp: '2.3.4.5',
                    versionOk: true,
                    providerVisible: true
                }
            };

            test.expect(1);
            provider.electMaster(instances)
                .then((response) => {
                    test.strictEqual(response, '2');
                })
                .catch((err) => {
                    test.ok(false, err.message);
                })
                .finally(() => {
                    test.done();
                });
        },

        testVersionNotOk(test) {
            const instances = {
                1: {
                    privateIp: '1.2.3.4',
                    versionOk: false,
                    providerVisible: true
                },
                2: {
                    privateIp: '2.3.4.5',
                    versionOk: true,
                    providerVisible: true
                }
            };

            test.expect(1);
            provider.electMaster(instances)
                .then((response) => {
                    test.strictEqual(response, '2');
                })
                .catch((err) => {
                    test.ok(false, err.message);
                })
                .finally(() => {
                    test.done();
                });
        },

        testExternal(test) {
            const instances = {
                1: {
                    privateIp: '1.2.3.4',
                    versionOk: true,
                    providerVisible: true
                },
                2: {
                    privateIp: '2.3.4.5',
                    versionOk: true,
                    providerVisible: true,
                    external: true
                }
            };

            test.expect(1);
            provider.electMaster(instances)
                .then((response) => {
                    test.strictEqual(response, '2');
                })
                .catch((err) => {
                    test.ok(false, err.message);
                })
                .finally(() => {
                    test.done();
                });
        }
    },

    testGetInstanceId(test) {
        test.expect(1);
        provider.getInstanceId()
            .then((response) => {
                test.strictEqual(response, instanceId);
            })
            .catch((err) => {
                test.ok(false, err.message);
            })
            .finally(() => {
                test.done();
            });
    },

    testGetInstances: {
        setUp(cb) {
            computeMock.zone = function zone() {
                return {
                    instanceGroup() {
                        return {
                            getVMs() {
                                return [
                                    [
                                        vm1
                                    ]
                                ];
                            }
                        };
                    }
                };
            };

            provider.providerOptions = {
                instanceGroup: 'foo'
            };

            provider.storageBucket = {
                getFiles() {
                    return q([
                        [
                            {
                                download() {
                                    return [
                                        JSON.stringify(instance1)
                                    ];
                                },
                                getMetadata() {
                                    return [
                                        {
                                            name: 'instances/vm1'
                                        }
                                    ];
                                }
                            }
                        ]
                    ]);
                }
            };

            provider.compute = computeMock;
            cb();
        },

        testBasic(test) {
            test.expect(3);
            provider.getInstances()
                .then((response) => {
                    test.strictEqual(Object.keys(response).length, 1);
                    test.deepEqual(response.vm1.id, instance1.id);
                    test.deepEqual(response.vm1.isMaster, instance1.isMaster);
                })
                .catch((err) => {
                    test.ok(false, err);
                })
                .finally(() => {
                    test.done();
                });
        },

        testExternalInstances(test) {
            computeMock.zone = function zone() {
                return {
                    instanceGroup() {
                        return {
                            getVMs() {
                                return [
                                    [
                                        vm1
                                    ]
                                ];
                            }
                        };
                    }
                };
            };

            provider.getVmsByTag = function getVmsByTag() {
                return q([
                    {
                        id: 'vm2',
                        ip: {
                            public: '10.11.12.13',
                            private: '15.16.17.18'
                        }
                    }
                ]);
            };

            test.expect(2);
            provider.getInstances({ externalTag: 'foo' })
                .then((response) => {
                    test.strictEqual(Object.keys(response).length, 2);
                    test.deepEqual(response.vm2.external, true);
                })
                .catch((err) => {
                    test.ok(false, err);
                })
                .finally(() => {
                    test.done();
                });
        },

        testMissingInstances(test) {
            provider.storageBucket = {
                getFiles() {
                    return q([[]]);
                }
            };

            test.expect(2);
            provider.getInstances()
                .then((response) => {
                    test.strictEqual(Object.keys(response).length, 1);
                    test.deepEqual(response.vm1.privateIp, '1.2.3.4');
                })
                .catch((err) => {
                    test.ok(false, err);
                })
                .finally(() => {
                    test.done();
                });
        }
    },

    testGetMessages(test) {
        const message1 = 'i am message 1';
        const message2 = 'i am message 2';

        provider.pubSub = {
            pull() {
                return q(
                    [
                        {
                            toInstanceId: '1',
                            message: message1
                        },
                        {
                            toInstanceId: '2',
                            message: message2
                        }
                    ]
                );
            }
        };

        test.expect(2);
        provider.getMessages([CloudProvider.MESSAGE_SYNC_COMPLETE], { toInstanceId: '1' })
            .then((response) => {
                test.strictEqual(response.length, 1);
                test.strictEqual(response[0].message, message1);
            })
            .catch((err) => {
                test.ok(false, err);
            })
            .finally(() => {
                test.done();
            });
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

            let passedOptions;

            provider.region = region;

            provider.compute.getVMs = function getVMs(options) {
                passedOptions = options;
                return new Promise((resolve) => {
                    resolve([[
                        {
                            id: vmId,
                            name: vmId,
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
                            },
                            getMetadata() {
                                return q([this.metadata]);
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
    },
    testTagMaster: {
        setUp(callback) {
            const instances = {
                'bigip-bf4b': {
                    tags: [
                        'other-tag'
                    ]
                },
                'bigip-jjzs': {
                    tags: [
                        'other-tag', 'foo-master'
                    ]
                },
                'bigip-uuio': {
                    tags: [
                        'other-tag'
                    ]
                }
            };

            computeMock.zone = function zone() {
                return {
                    vm(name) {
                        return {
                            name,
                            getTags() {
                                return [
                                    instances[name].tags,
                                    'fingerprint',
                                    { name }
                                ];
                            },
                            setTags(tags, fingerprint) {
                                vmSetTagsParams[name] = {
                                    tags,
                                    fingerprint
                                };
                                return q();
                            }
                        };
                    }
                };
            };

            provider.compute = computeMock;
            callback();
        },

        testTagMasterInstance(test) {
            provider.providerOptions = {
                instanceGroup: 'foo'
            };

            const masterIid = 'bigip-bf4b';
            const instances = {
                'bigip-bf4b': {
                    privateIp: '10.0.2.11'
                },
                'bigip-jjzs': {
                    privateIp: '10.0.2.11'
                },
                'bigip-uuio': {
                    privateIp: '10.0.2.12'
                }
            };

            test.expect(4);
            provider.tagMasterInstance(masterIid, instances)
                .then(() => {
                    test.strictEqual(vmSetTagsParams['bigip-uuio'], undefined);
                    test.strictEqual(vmSetTagsParams['bigip-jjzs'].tags.indexOf('foo-master'), -1);
                    test.notStrictEqual(vmSetTagsParams[masterIid].tags.indexOf('foo-master'), -1);
                    test.strictEqual(vmSetTagsParams[masterIid].fingerprint, 'fingerprint');
                })
                .catch((err) => {
                    test.ok(false, err);
                })
                .finally(() => {
                    test.done();
                });
        },
    },

    testMasterElected(test) {
        let instanceIdSent;
        let instanceSent;

        provider.providerOptions = {
            instanceGroup: 'foo'
        };

        provider.storageBucket = {
            getFiles() {
                return q([
                    [
                        {
                            download() {
                                return [
                                    JSON.stringify({
                                        isMaster: true
                                    })
                                ];
                            },
                            getMetadata() {
                                return [
                                    {
                                        name: 'instances/vm1'
                                    }
                                ];
                            }
                        },
                        {
                            download() {
                                return [
                                    JSON.stringify({
                                        isMaster: true
                                    })
                                ];
                            },
                            getMetadata() {
                                return [
                                    {
                                        name: 'instances/vm2'
                                    }
                                ];
                            }
                        }
                    ]
                ]);
            }
        };

        provider.pubSub = {
            getSubscriptions() {
                return q([[]]);
            },
            createSubscription() {
                return q();
            },
            getTopics() {
                return q([[]]);
            },
            createTopic() {
                return q();
            }
        };

        provider.putInstance = function putInstance(dbInstanceId, instance) {
            instanceIdSent = dbInstanceId;
            instanceSent = instance;
        };

        provider.masterElected('vm1')
            .then(() => {
                test.strictEqual(instanceIdSent, 'vm2');
                test.strictEqual(instanceSent.isMaster, false);
            })
            .catch((err) => {
                test.ok(false, err);
            })
            .finally(() => {
                test.done();
            });
    }
};

/**
* Copyright 2017-2018 F5 Networks, Inc.
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

const fs = require('fs');
const util = require('util');
const path = require('path');
const stream = require('stream');

const q = require('q');

const Compute = require('@google-cloud/compute');
const Storage = require('@google-cloud/storage');

const CloudProvider = require('@f5devcentral/f5-cloud-libs').cloudProvider;
const AutoscaleInstance = require('@f5devcentral/f5-cloud-libs').autoscaleInstance;
const BigIp = require('@f5devcentral/f5-cloud-libs').bigIp;
const Logger = require('@f5devcentral/f5-cloud-libs').logger;
const cloudUtil = require('@f5devcentral/f5-cloud-libs').util;
const cryptoUtil = require('@f5devcentral/f5-cloud-libs').cryptoUtil;
const PubSub = require('../src/gcClients/pubSub');
const KEYS = require('@f5devcentral/f5-cloud-libs').sharedConstants.KEYS;

const CREDENTIALS_FILE = 'credentials/primary';
const INSTANCES_FOLDER = 'instances/';
const PUBLIC_KEYS_FOLDER = 'public_keys/';
const BACKUP_FOLDER = 'backup/';

const JOIN_PREFIX = 'JOIN_';
const SYNC_COMPLETE_PREFIX = 'SYNC_COMPLETE_';

let bigIp;
let logger;

util.inherits(GceCloudProvider, CloudProvider);

/**
* Constructor.
* @class
* @classdesc
* Azure cloud provider implementation.
*
* @param {Ojbect} [options]               - Options for the instance.
* @param {Object} [options.clOptions]     - Command line options if called from a script.
* @param {Object} [options.logger]        - Logger to use. Or, pass loggerOptions to get your own logger.
* @param {Object} [options.loggerOptions] - Options for the logger.
*                                           See {@link module:logger.getLogger} for details.
*/
function GceCloudProvider(options) {
    GceCloudProvider.super_.call(this, options);

    this.features[CloudProvider.FEATURE_MESSAGING] = true;
    this.features[CloudProvider.FEATURE_ENCRYPTION] = true;

    this.loggerOptions = options ? options.loggerOptions : undefined;

    logger = options ? options.logger : undefined;

    if (logger) {
        this.logger = logger;
        cloudUtil.setLogger(logger);
        cryptoUtil.setLogger(logger);
    } else if (this.loggerOptions) {
        this.loggerOptions.module = module;
        logger = Logger.getLogger(this.loggerOptions);
        cloudUtil.setLoggerOptions(this.loggerOptions);
        cryptoUtil.setLoggerOptions(this.loggerOptions);
        this.logger = logger;
    } else {
        // use super's logger
        logger = this.logger;
        cloudUtil.setLogger(logger);
        cryptoUtil.setLogger(logger);
    }
}

/* eslint-disable max-len */
/**
 * Initialize class
 *
 * Override for implementation specific initialization needs (read info
 * from cloud provider, read database, etc.). Called at the start of
 * processing.
 *
 * @param {Object}  [providerOptions]                 - Provider specific options.
 * @param {String}  [providerOptions.region]          - Region to use for searching instances. Required if
 *                                                      BIG-IP is not running Google Cloud or if pool members
 *                                                      are in a different region.
 * @param {Number}  [providerOptions.mgmtPort]        - BIG-IP management port. Default 443.
 * @param {String}  [providerOptions.serviceAccount]  - Name of Google Cloud service account.
 *                                                      Required for cluster and autoscale solutions.
 * @param {String}  [providerOptions.storageBucket]   - Name of Google Cloud Storage bucket to use for storage.
 *                                                      Required for cluster and autoscale solutions.
 * @param {String}  [providerOptions.secret]          - Base64 encoded Google Cloud credentials.
 *                                                      Required if BIG-IP is not running in Google Cloud.
 * @param {String}  [providerOptions.instanceGroup]   - Unique name in project for this instance group.
 *                                                      Required for autoscale.
 * @param {Object}  [options]                         - Options for this instance.
 * @param {Boolean} [options.autoscale]               - Whether or not this instance will
 *                                                      be used for autoscaling.
 *
 * @returns {Promise} A promise which will be resolved when init is complete.
 */
/* eslint-enable max-len */
GceCloudProvider.prototype.init = function init(providerOptions, options) {
    this.mgmtPort =
        providerOptions && providerOptions.mgmtPort ? providerOptions.mgmtPort : this.clOptions.port || '443';
    this.initOptions = options || {};
    this.providerOptions = providerOptions || {};

    this.instancesToRevoke = [];

    if (this.initOptions.autoscale) {
        if (!this.providerOptions.serviceAccount) {
            return q.reject(
                new Error('provider.options.serviceAccount is required when used for autoscaling')
            );
        }
        if (!this.providerOptions.instanceGroup) {
            return q.reject(new Error('providerOptions.instanceGroup is required when used for autoscaling'));
        }
    }

    this.region = providerOptions ? providerOptions.region : undefined;
    if (providerOptions.secret) {
        this.logger.silly('Got credentials from providerOptions');

        if (!this.region) {
            const message = 'providerOptions.region is required when providing credentials';
            this.logger.info(message);
            return q.reject(new Error(message));
        }

        let credentials;
        try {
            const credentialsBuf = cloudUtil.createBufferFrom(providerOptions.secret, 'base64');
            credentials = JSON.parse(credentialsBuf.toString());
        } catch (err) {
            this.logger.info('Error parsing credentials');
            return q.reject(err);
        }

        this.compute = new Compute({ credentials });
        this.storage = new Storage({ credentials });

        // TODO: Add credentials handling to our pubSub client
    } else {
        this.logger.silly('No provider credentials - assuming we are running in Google Cloud');
        this.compute = new Compute();
        this.storage = new Storage();

        if (this.initOptions.autoscale) {
            // Sadly, the Google node sdk pubSub client cores node on BIG-IP
            // so we have our own
            this.pubSub = new PubSub(
                this.providerOptions.serviceAccount,
                { loggerOptions: this.loggerOptions }
            );
        }
    }

    if (providerOptions.storageBucket) {
        this.storageBucket = this.storage.bucket(providerOptions.storageBucket);
    }

    if (!this.region) {
        // If we weren't given a region, get region we are in from metadata service
        return getMetadata('instance/zone')
            .then((data) => {
                // zone info is in the format 'projects/734288666861/zones/us-west1-a',
                // so grab the part after the last '/''
                const parts = data.split('/');
                const zone = parts[parts.length - 1];

                // In a region, zones can talk to each other, so grab region
                this.region = getRegionFromZone(zone);

                logger.silly('region:', this.region);
                return q();
            });
    }

    return q();
};

/**
 * BIG-IP is now ready and providers can run BIG-IP functions
 * if necessary
 *
 * @returns {Promise} A promise which will be resolved when init is complete.
 */
GceCloudProvider.prototype.bigIpReady = function bigIpReady() {
    if (this.clOptions.user && (this.clOptions.password || this.clOptions.passwordUrl)) {
        bigIp = new BigIp({ loggerOptions: this.loggerOptions });
        return bigIp.init(
            'localhost',
            this.clOptions.user,
            this.clOptions.password || this.clOptions.passwordUrl,
            {
                port: parseInt(this.mgmtPort, 10),
                passwordIsUrl: typeof this.clOptions.passwordUrl !== 'undefined',
                passwordEncrypted: this.clOptions.passwordEncrypted
            }
        )
            .then(() => {
                if (this.instancesToRevoke.length > 0) {
                    logger.debug('Revoking licenses of non-primaries that are not known to GCE');
                    return this.revokeLicenses(this.instancesToRevoke, { bigIp });
                }
                return q();
            });
    }
    return q();
};

/**
 * Elects a new primary instance from the available instances
 *
 * @abstract
 *
 * @param {Object} instances - Dictionary of instances as returned by getInstances
 *
 * @returns {Promise} A promise which will be resolved with the instance ID of the
 *                    elected primary.
 */
GceCloudProvider.prototype.electPrimary = function electPrimary(instances) {
    let lowestGlobalIp = Number.MAX_SAFE_INTEGER;
    let lowestExternalIp = Number.MAX_SAFE_INTEGER;

    let currentIpToNumber;
    let primaryId;
    let externalPrimaryId;

    const canInstanceBeElected = function (instance) {
        if (instance.versionOk && instance.providerVisible) {
            return true;
        }
        return false;
    };

    Object.keys(instances).forEach((instanceId) => {
        const instance = instances[instanceId];
        if (canInstanceBeElected.call(this, instance)) {
            currentIpToNumber = cloudUtil.ipToNumber(instance.privateIp);
            if (currentIpToNumber < lowestGlobalIp) {
                lowestGlobalIp = currentIpToNumber;
                primaryId = instanceId;
            }
            if (instance.external) {
                if (currentIpToNumber < lowestExternalIp) {
                    lowestExternalIp = currentIpToNumber;
                    externalPrimaryId = instanceId;
                }
            }
        }
    });

    // prefer external instances (for example, BYOL instances)
    if (externalPrimaryId) {
        logger.silly('electPrimary: using external primary');
        primaryId = externalPrimaryId;
    }
    logger.silly('electPrimary: electedPrimary:', instances[primaryId]);

    return q(primaryId);
};

/**
 * Gets the instance ID of this instance
 *
 * @returns {Promise} A promise which will be resolved with the instance ID of this instance
 *                    or rejected if an error occurs;
 */
GceCloudProvider.prototype.getInstanceId = function getInstanceId() {
    // Would like to use instance/id below, but VM.id and VM.name are the same in our
    // SDK version. We use name in case they ever change this. We neeed the metadata
    // field and VM field to match
    return getMetadata('instance/name')
        .then((instanceId) => {
            this.instanceId = instanceId;
            return this.instanceId;
        });
};

/**
 * Gets info for each instance
 *
 * Retrieval is cloud specific. Likely either from the cloud infrastructure
 * itself, stored info that we have in a database, or both.
 *
 * @param {Object} [options] - Optional parameters
 * @param {String} [options.externalTag] - Also look for instances with this
 *                                         tag (outside of the autoscale group/set)
 *
 * @returns {Promise} A promise which will be resolved with a dictionary of instances
 *                    keyed by instance ID. Each instance value should be:
 *
 *                   {
 *                       isPrimary: <Boolean>,
 *                       hostname: <String>,
 *                       mgmtIp: <String>,
 *                       privateIp: <String>,
 *                       publicIp: <String>,
 *                       providerVisible: <Boolean> (does the cloud provider know about this instance),
 *                       external: <Boolean> (true if this instance is external to the autoscale group/set)
 *                   }
 */
GceCloudProvider.prototype.getInstances = function getInstances(options) {
    const VALID_STATUSES = ['PROVISIONING', 'STAGING', 'RUNNING'];
    const instances = {};
    const gceVms = {};
    const gceInstanceIds = [];
    const externalGceInstanceIds = [];
    const idsToDelete = [];

    return getMetadata('instance/zone')
        .then((metadataZone) => {
            // Get the instances GCE knows about
            const zoneId = getZoneFromMetadataZone(metadataZone);
            const zone = this.compute.zone(zoneId);
            const instanceGroup = zone.instanceGroup(this.providerOptions.instanceGroup);
            return instanceGroup.getVMs();
        })
        .then((data) => {
            const instanceGroupVms = data[0] || [];

            this.logger.silly('all instances from gce:', instanceGroupVms);

            instanceGroupVms.forEach((vm) => {
                if (VALID_STATUSES.indexOf(vm.metadata.status) !== -1) {
                    gceInstanceIds.push(vm.name);
                    gceVms[vm.name] = vm;
                }
            });

            this.logger.silly('instance ids with good status:', gceInstanceIds);

            // If we were given an external tag, look for those vms
            if (options && options.externalTag) {
                return this.getVmsByTag(options.externalTag);
            }
            return [];
        })
        .then((externalVms) => {
            this.logger.silly('external vms:', externalVms);

            if (externalVms) {
                externalVms.forEach((vm) => {
                    externalGceInstanceIds.push(vm.id);
                    instances[vm.id] = new AutoscaleInstance()
                        .setPrivateIp(vm.ip.private)
                        .setPublicIp(vm.ip.public)
                        .setMgmtIp(vm.ip.private)
                        .setProviderVisible()
                        .setExternal();
                });
            }

            // get instances we have in the database
            return getInstancesFromDb.call(this);
        })
        .then((instancesFromDb) => {
            const missingPromises = [];

            this.logger.silly('instances in db:', instancesFromDb);

            const instanceIdsInDb = Object.keys(instancesFromDb);
            instanceIdsInDb.forEach((instanceId) => {
                const instance = instancesFromDb[instanceId];
                if (gceInstanceIds.indexOf(instanceId) !== -1) {
                    instances[instanceId] = instance;
                    instances[instanceId].providerVisible = true;
                } else if (instance.isPrimary && !this.isInstanceExpired(instance)) {
                    instances[instanceId] = instance;
                    instances[instanceId].providerVisible = false;
                } else {
                    // Get a list of non-primary instances that we have in our db that GCE
                    // does not know about and delete them
                    idsToDelete.push(instanceId);
                    this.instancesToRevoke.push(instance);
                }
            });

            // Find instances reported by cloud provider that we do not have
            gceInstanceIds.forEach((gceInstanceId) => {
                if (instanceIdsInDb.indexOf(gceInstanceId) === -1) {
                    missingPromises.push(getVmInfo.call(this, gceVms[gceInstanceId]));
                }
            });
            return q.all(missingPromises);
        })
        .then((missingInstances) => {
            missingInstances.forEach((missingInstance) => {
                if (missingInstance) {
                    instances[missingInstance.id] = new AutoscaleInstance()
                        .setPrivateIp(missingInstance.ip.private)
                        .setPublicIp(missingInstance.ip.public)
                        .setMgmtIp(missingInstance.ip.private)
                        .setProviderVisible();
                }
            });

            logger.debug('Deleting non-primaries that are not in GCE', idsToDelete);
            return deleteInstances.call(this, idsToDelete);
        })
        .then(() => {
            return q(instances);
        })
        .catch((err) => {
            this.logger.info('Error getting instances:', err && err.message ? err.message : err);
            return q.reject(err);
        });
};

/**
 * Called to retrieve primary instance credentials
 *
 * Management IP and port are passed in so that credentials can be
 * validated if desired.
 *
 * @abstract
 *
 * @param {String} mgmtIp - Management IP of primary.
 * @param {String} port - Management port of primary.
 *
 * @returns {Promise} A promise which will be resolved with:
 *
 *                    {
 *                        username: <admin_user>,
 *                        password: <admin_password>
 *                    }
 */
GceCloudProvider.prototype.getPrimaryCredentials = function getPrimaryCredentials(mgmtIp, mgmtPort) {
    let credentials;
    let primaryBigIp;

    return getData.call(this, CREDENTIALS_FILE)
        .then((data) => {
            credentials = data;
            primaryBigIp = new BigIp({ loggerOptions: this.loggerOptions });
            return primaryBigIp.init(
                mgmtIp,
                credentials.username,
                credentials.password,
                { port: mgmtPort || this.mgmtPort }
            );
        })
        .then(() => {
            return primaryBigIp.ready(cloudUtil.NO_RETRY);
        })
        .then(() => {
            logger.debug('Validated credentials.');
            return credentials;
        })
        .catch((err) => {
            logger.info('Error getting primary credentials', err);
            return q.reject(err);
        });
};

/**
 * Gets info on what this instance thinks the primary status is
 *
 * @returns {Promise} A promise which will be resolved with a dictionary of primary
 *                    status. Each status value should be:
 *
 *                    {
 *                        'instanceId": primaryInstanceId
 *                        "status": CloudProvider.STATUS_*
 *                        "lastUpdate": Date,
 *                        "lastStatusChange": Date
 *                    }
 *
 */
GceCloudProvider.prototype.getPrimaryStatus = function getPrimaryStatus() {
    return getData.call(this, INSTANCES_FOLDER + this.instanceId)
        .then((instance) => {
            const primaryStatus = instance.primaryStatus || {};

            if (primaryStatus) {
                return {
                    instanceId: primaryStatus.instanceId,
                    status: primaryStatus.status,
                    lastUpdate: primaryStatus.lastUpdate,
                    lastStatusChange: primaryStatus.lastStatusChange
                };
            }
            return {};
        })
        .catch((err) => {
            logger.info('Error getting primary status', err);
            return q.reject(err);
        });
};

/**
 * Gets messages from other instances in the scale set
 *
 * @param {String[]} actions               - Array of actions to get. Other messages will be ignored.
 *                                           Default is no messages will be retrieved.
 * @param {Object}  [options]              - Optional parameters
 * @param {String}  [options.toInstanceId] - toInstanceId of messsages we are interested in
 *
 * @returns {Promise} A promise which will be resolved when the messages
 *                    have been received and processed. Promise should be
 *                    resolved with an array of messages of the form
 *
 *                    {
 *                        action: message action id,
 *                        toInstanceId: instanceId,
 *                        fromInstanceId: instanceId,
 *                        data: message specific data used in sendMessage,
 *                        completionHandler: optional completionHandler to call wnen done processing
 *                        {
 *                            this: this arg for callback context,
 *                            callback: function to call,
 *                            data: data to send to function
 *                        }
 *                    }
 */
GceCloudProvider.prototype.getMessages = function getMessages(actions, options) {
    const promises = [];
    const subscriptions = [];

    const syncSubscriptionName = getSyncSubscriptionName.call(this);
    const joinSubscriptionName = getJoinSubscriptionName.call(this);

    actions.forEach((action) => {
        if (action === CloudProvider.MESSAGE_SYNC_COMPLETE) {
            subscriptions.push(syncSubscriptionName);
        } else if (action === CloudProvider.MESSAGE_ADD_TO_CLUSTER) {
            subscriptions.push(joinSubscriptionName);
        }
    });

    subscriptions.forEach((subscription) => {
        promises.push(this.pubSub.pull(subscription));
    });

    return q.all(promises)
        .then((subscriptionResults) => {
            const messages = [];
            subscriptionResults.forEach((subMessages) => {
                if (subMessages) {
                    subMessages.forEach((message) => {
                        if (options
                            && options.toInstanceId
                            && options.toInstanceId === message.toInstanceId) {
                            messages.push(message);
                        } else if (options && !options.toInstanceId) {
                            messages.push(message);
                        }
                    });
                }
            });

            return q(messages);
        })
        .catch((err) => {
            logger.info('Error getting messages', err);
            return q.reject(err);
        });
};

/**
* Searches for NICs that have a given tag.
*
* @param {Object} tag - Tag to search for. Tag is of the format:
*
*                 {
*                     key: optional key
*                     value: value to search for
*                 }
*
* @returns {Promise} A promise which will be resolved with an array of instances.
*                    Each instance value should be:
*
*                   {
*                       id: NIC ID,
*                       ip: {
*                           public: public IP (or first public IP on the NIC),
*                           private: private IP (or first private IP on the NIC)
*                       }
*                   }
*/
GceCloudProvider.prototype.getNicsByTag = function getNicsByTag() {
    // In GCE, for now, you can only label external static network addresses.
    // As this is ucommon, we do not support labeled nics.

    return q([]);
};

/**
* Searches for VMs that have a given tag.
*
* @param {Object} tag - Tag to search for. Tag is of the format:
*
*                 {
*                     key: optional key
*                     value: value to search for
*                 }
*
* @returns {Promise} A promise which will be resolved with an array of instances.
*                    Each instance value should be:
*
*                   {
*                       id: instance ID,
*                       ip: {
*                           public: public IP (or first public IP on the first NIC),
*                           private: private IP (or first private IP on the first NIC)
*                       }
*                   }
*/
GceCloudProvider.prototype.getVmsByTag = function getVmsByTag(tag) {
    const deferred = q.defer();
    const vms = [];

    if (!tag || !tag.key || !tag.value) {
        deferred.reject(new Error('Tag with key and value must be provided'));
        return deferred.promise;
    }

    // Labels in GCE must be lower case
    const options = {
        filter: `labels.${tag.key.toLowerCase()} eq ${tag.value.toLowerCase()}`
    };

    this.compute.getVMs(options)
        .then((data) => {
            const computeVms = data !== undefined ? data : [[]];
            const promises = [];

            computeVms[0].forEach((vm) => {
                if (getRegionFromZone(vm.zone.id) === this.region) {
                    promises.push(getVmInfo.call(this, vm));
                }
            });

            return q.all(promises);
        })
        .then((data) => {
            data.forEach((vm) => {
                if (vm) {
                    vms.push(vm);
                }
            });

            deferred.resolve(vms);
        })
        .catch((err) => {
            deferred.reject(err);
        });

    return deferred.promise;
};

/**
 * Gets the public key for an instanceId.
 *
 * @param {String} instanceId - ID of instance to retrieve key for.
 *
 * @returns {Promise} A promise which will be resolved when the operation
 *                    is complete
 */
GceCloudProvider.prototype.getPublicKey = function getPublicKey(instanceId) {
    return getData.call(this, PUBLIC_KEYS_FOLDER + instanceId);
};

/**
 * Called to get check for and retrieve a stored UCS file
 *
 * Provider implementations can optionally store a UCS to be
 * used to restore a primary instance to a last known good state
 *
 * @returns {Promise} A promise which will be resolved with a Buffer containing
 *                    the UCS data if it is present, resolved with undefined if not
 *                    found, or rejected if an error occurs.
 */
GceCloudProvider.prototype.getStoredUcs = function getStoredUcs() {
    const options = {
        prefix: BACKUP_FOLDER
    };

    return this.storageBucket.getFiles(options)
        .then((data) => {
            const files = data[0] || [];
            const metadataPromises = [];

            this.logger.silly('files', files);

            files.forEach((file) => {
                metadataPromises.push(file.getMetadata());
            });

            return q.all(metadataPromises);
        })
        .then((results) => {
            const metadataResults = results[0] || [];

            if (metadataResults.length > 0) {
                // Sort so that newest is first
                metadataResults.sort((a, b) => {
                    const aUpdated = new Date(a.updated);
                    const bUpdated = new Date(b.updated);

                    if (aUpdated < bUpdated) {
                        return 1;
                    } else if (bUpdated < aUpdated) {
                        return -1;
                    }
                    return 0;
                });

                return getData.call(this, metadataResults[0].name);
            }

            logger.debug('No UCS found in S3');
            return q();
        });
};

/**
 * Gets data from a provider specific URI
 *
 * URI must be a gsutil link to a JSON blob
 *
 * @param {String} uri - The cloud-specific URI of the resource. In this case, the URI is
 *                       expected to be a gsutil link
 *
 * @returns {Promise} A promise which will be resolved with the data from the URI
 *                    or rejected if an error occurs.
 */
GceCloudProvider.prototype.getDataFromUri = function getDataFromUri(uri) {
    // verify gsutil link
    const gsutilPrefix = 'gs://';

    if (!uri.startsWith(gsutilPrefix)) {
        return q.reject(new Error('Invalid URI. URI should be a gsutil.'));
    }

    // gsutil format is gs://bucket/[folder/]filename
    let parts = uri.split('gs://');

    parts = parts[1].split('/');
    if (parts.length < 2 || parts[1] === '') {
        const exampleURI = 'gs://bucket/filename';
        return q.reject(new Error(`Invalid URI. Format should be ${exampleURI}`));
    }

    // Support files in 'folders'
    const bucket = parts.splice(0, 1)[0];
    const filename = parts.join('/');

    return getData.call(this, filename, { bucket });
};

/**
 * Called when a primary has been elected
 *
 * In some cloud environments, information about the primary needs to be
 * stored in persistent storage. Override this method if implementing
 * such a cloud provider.
 *
 * @param {String} instancId - Instance ID that was elected primary.
 *
 * @returns {Promise} A promise which will be resolved when processing is complete.
 */
GceCloudProvider.prototype.primaryElected = function primaryElected(instanceId) {
    return setupTopicsAndSubscriptions.call(this, this.instanceId === instanceId)
        .then(() => {
            // Find other instance in the db that are marked as primary, and mark them as non-primary
            return getInstancesFromDb.call(this);
        })
        .then((instancesFromDb) => {
            const instanceIdsInDb = Object.keys(instancesFromDb);
            const promises = [];
            let instance;

            instanceIdsInDb.forEach((dbInstanceId) => {
                instance = instancesFromDb[dbInstanceId];
                if (dbInstanceId !== instanceId && instance.isPrimary) {
                    instance.isPrimary = false;
                    promises.push(this.putInstance.call(this, dbInstanceId, instance));
                }
            });

            // Note: we are not returning the promise here - no need to wait for this to complete
            q.all(promises);
        })
        .catch((err) => {
            this.logger.info('primaryElected error', err && err.message ? err.message : err);
            return q.reject(err);
        });
};

/**
 * Called when a primary has been elected.
 *
 * Update Virtual Machine instance Networks Tags, adding/removing the Deployment primary tag.
 *
 * @param {String} primaryId - The instance ID of the elected primary.
 * @param {Object} instances - Dictionary of instances as returned from getInstances.
 *
 * @returns {Promise} A promise which will be resolved when processing is complete.
 */
GceCloudProvider.prototype.tagPrimaryInstance = function tagPrimaryInstance(primaryIid, instances) {
    const vms = {};
    const primaryTag = `${this.providerOptions.instanceGroup}-primary`;

    return getMetadata('instance/zone')
        .then((metadataZone) => {
            const zoneId = getZoneFromMetadataZone(metadataZone);
            return this.compute.zone(zoneId);
        })
        .then((zone) => {
            const promises = [];
            Object.keys(instances).forEach((instanceName) => {
                promises.push(zone.vm(instanceName));
            });
            return q.all(promises);
        })
        .then((responses) => {
            // getTags for each vm, reserving 'vm' Object for setTags()
            const promises = [];
            responses.forEach((vm) => {
                vms[vm.name] = vm;
                promises.push(vm.getTags());
            });
            return q.all(promises);
        })
        .then((responses) => {
            const promises = [];
            responses.forEach((response) => {
                const tags = response[0];
                const fingerprint = response[1];
                const vmName = response[2].name;
                const hasTag = tags.indexOf(primaryTag) !== -1;

                // If Primary Instance, and instance is not tagged as primary, tag it as primary
                if (vmName === primaryIid && (!hasTag)) {
                    tags.push(primaryTag);
                    const vm = vms[vmName];
                    logger.debug(`Tagging Primary Instance as: ${vmName}`);
                    promises.push(vm.setTags(tags, fingerprint));
                }
                // If non-Primary Instance, and instance is tagged as primary, remove primary tag
                if (vmName !== primaryIid && hasTag) {
                    tags.splice(tags.indexOf(primaryTag), 1);
                    const vm = vms[vmName];
                    logger.debug(`Removing Primary tag from: ${vmName}`);
                    promises.push(vm.setTags(tags, fingerprint));
                }
            });
            return q.all(promises);
        })
        .catch((err) => {
            return q.reject(err);
        });
};

/**
 * Indicates that an instance that was primary is now invalid
 *
 * @param {String} [instanceId] - Instance ID of instnace that is no longer a valid
 *                                primary.
 *
 * @returns {Promise} A promise which will be resolved when processing is complete.
 */
GceCloudProvider.prototype.primaryInvalidated = function primaryInvalidated(instanceId) {
    // we don't care if deleting the instance is an error - perhaps it was already deleted
    deleteData.call(this, INSTANCES_FOLDER + instanceId);
    return q();
};

/**
 * Saves instance info
 *
 * Override for cloud implementations which store instance information.
 *
 * @param {String} instanceId - ID of instance
 * @param {Object} instance   - Instance information as returned by getInstances.
 *
 * @returns {Promise} A promise which will be resolved with instance info.
 */
GceCloudProvider.prototype.putInstance = function putInstance(instanceId, instance) {
    return putData.call(
        this,
        INSTANCES_FOLDER + instanceId,
        instance
    )
        .then(() => {
            return q();
        })
        .catch((err) => {
            this.logger.info('putInstance error:', err && err.message ? err.message : err);
            return q.reject(err);
        });
};

/**
 * Called to store primary credentials
 *
 * When joining a cluster we need the username and password for the
 * primary instance. This method is called to tell us that we are
 * the primary and we should store our credentials if we need to store
 * them for later retrieval in getPrimaryCredentials.
 *
 * @returns {Promise} A promise which will be resolved when the operation
 *                    is complete
 */
GceCloudProvider.prototype.putPrimaryCredentials = function putPrimaryCredentials() {
    return bigIp.getPassword()
        .then((password) => {
            return putData.call(
                this,
                CREDENTIALS_FILE,
                {
                    password,
                    username: this.clOptions.user
                }
            );
        })
        .then(() => {
            logger.silly('Wrote credentials');
            return q();
        })
        .catch((err) => {
            return q.reject(new Error(`Unable to store primary credentials: ${err}`));
        });
};

/**
 * Stores the public key for an instanceId.
 *
 * @param {String} instanceId - ID of instance to retrieve key for.
 * @param {String} publicKey - The public key
 *
 * @returns {Promise} A promise which will be resolved when the operation
 *                    is complete
 */
GceCloudProvider.prototype.putPublicKey = function putPublicKey(instanceId, publicKey) {
    return putData.call(
        this,
        PUBLIC_KEYS_FOLDER + instanceId,
        publicKey
    );
};

/**
 * Sends a message to other instances in the scale set
 *
 * @param {String} action                   - Action id of message to send
 * @param {Object} [options]                - Optional parameters
 * @param {String} [options.toInstanceId]   - Instance ID that message is for
 * @param {String} [options.fromInstanceId] - Instance ID that message is from
 * @param {Object} [options.data]           - Message specific data
 *
 * @returns {Promise} A promise which will be resolved when the message
 *                    has been sent or rejected if an error occurs
 */
GceCloudProvider.prototype.sendMessage = function sendMessage(action, options) {
    const message = {
        action,
        toInstanceId: options.toInstanceId,
        fromInstanceId: options.fromInstanceId,
        data: options.data
    };

    let topic;

    if (action === CloudProvider.MESSAGE_ADD_TO_CLUSTER) {
        topic = getJoinTopicName.call(this);
    } else if (action === CloudProvider.MESSAGE_SYNC_COMPLETE) {
        topic = getSyncTopicName.call(this);
    }

    return this.pubSub.publish(topic, message);
};

/**
 * Stores a UCS file in cloud storage
 *
 * @param {String} file      - Full path to file to store.
 * @param {Number} maxCopies - Number of files to store. Oldest files over
 *                             this number should be deleted.
 * @param {String} prefix    - The common prefix for autosaved UCS files
 *
 * @returns {Promise} A promise which is resolved when processing is complete.
 */
GceCloudProvider.prototype.storeUcs = function storeUcs(file, maxCopies, prefix) {
    const filename = `${BACKUP_FOLDER}${path.basename(file)}`;
    return putData.call(this, filename, fs.createReadStream(file))
        .then(() => {
            return deleteOldestObjects.call(
                this,
                BACKUP_FOLDER,
                maxCopies,
                prefix
            );
        })
        .catch((err) => {
            return q.reject(new Error(`storeUcs: ${err}`));
        });
};

/**
 * Called to delete a stored UCS file based on filename
 *
 * @param   {String}  UCS filename
 *
 * @returns {Promise} returns a promise which resolves with status of delete operation
 *                    or gets rejected in a case of failures
 *
 */

GceCloudProvider.prototype.deleteStoredUcs = function deleteStoredUcs(fileName) {
    return deleteData.call(this, `${BACKUP_FOLDER}${fileName}`);
};

/**
 * Informs the provider that a sync has completed in case the
 * password needs to be updated
 *
 * When a sync is complete, the user and password will exist on
 * the synced to device.
 *
 * @param {String} fromUser     - User that was synced from
 * @param {String} fromPassword - Password that was synced from
 *
 * @returns {Promise} A promise which will be resolved when the messages
 *                    have been received and processed
 */
GceCloudProvider.prototype.syncComplete = function syncComplete(fromUser, fromPassword) {
    // update the bigIp password
    logger.debug('Updating local password');
    bigIp.password = fromPassword;

    if (this.clOptions.passwordUrl) {
        this.logger.debug('Updating local password file');
        return cryptoUtil.encrypt(KEYS.LOCAL_PUBLIC_KEY_PATH, fromPassword)
            .then((encryptedPassword) => {
                return cloudUtil.writeDataToUrl(encryptedPassword, this.clOptions.passwordUrl);
            })
            .catch((err) => {
                this.logger.warn('Unable to update password URL', this.clOptions.passwordUrl, err);
                return q.reject(err);
            });
    }

    return q();
};

function deleteInstances(idsToDelete) {
    const promises = [];
    idsToDelete.forEach((idToDelete) => {
        promises.push(deleteData.call(this, INSTANCES_FOLDER + idToDelete));
        promises.push(deleteData.call(this, PUBLIC_KEYS_FOLDER + idToDelete));
    });
    return q.all(promises);
}

/**
 * Queries local metadata service for an entry
 *
 * @param {String} entry - The name of the metadata entry. For example 'instance/zone'
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
            logger.info(message);
            return q.reject(err);
        });
}

/**
 * Gets the zone from a region.
 *
 * For example, 'us-west1-a' returns 'us-west1'
 */
function getRegionFromZone(zone) {
    return zone.substr(0, zone.lastIndexOf('-'));
}

/**
 * Returns specific info about a VM
 *
 * @param {VM} vm - A Google cloud VM instance.
 *                  See {@link https://cloud.google.com/nodejs/docs/reference/compute/0.10.x/VM}
 *
 * @returns {Promise} A promise which is resolved with vm info in the format
 *    {
 *        id: vm_id,
 *        ip: {
 *            public: public_ip_address,
 *            private: private_ip_address
 *        }
 *    }
 *
 */
function getVmInfo(vm) {
    let nic;
    let publicIp;

    return vm.getMetadata()
        .then((data) => {
            const metadata = data[0];
            if (metadata && metadata.networkInterfaces[0]) {
                nic = metadata.networkInterfaces[0];
                if (nic.accessConfigs && nic.accessConfigs[0] && nic.accessConfigs[0].natIP) {
                    publicIp = nic.accessConfigs[0].natIP;
                }

                // Would like to use vm.id below, but VM.id and VM.name are the same in our
                // SDK version. We use name in case they ever change this.
                return {
                    id: vm.name,
                    ip: {
                        public: publicIp,
                        private: nic.networkIP
                    }
                };
            }
            return q();
        })
        .catch((err) => {
            const message = `Unable to get vm info: ${err && err.message ? err.message : err}`;
            this.logger.info(message);
            return q.reject(err);
        });
}

function getInstancesFromDb() {
    const options = {
        prefix: INSTANCES_FOLDER
    };
    const instances = {};

    let files = [];

    return this.storageBucket.getFiles(options)
        .then((data) => {
            files = data[0] || [];
            const downloadPromises = [];

            files.forEach((file) => {
                downloadPromises.push(file.download());
            });

            return q.all(downloadPromises);
        })
        .then((results) => {
            const metadataPromises = [];
            for (let i = 0; i < results.length; ++i) {
                files[i].contents = JSON.parse(results[i][0]);
                metadataPromises.push(files[i].getMetadata());
            }
            return q.all(metadataPromises);
        })
        .then((results) => {
            for (let i = 0; i < results.length; ++i) {
                const metadata = results[i][0];
                const instanceId = metadata.name.substr(INSTANCES_FOLDER.length);
                instances[instanceId] = files[i].contents;
            }
            return q(instances);
        })
        .catch((err) => {
            const message = `Unable to get file instances from db: ${err && err.message ? err.message : err}`;
            this.logger.info(message);
            return q.reject(err);
        });
}

function deleteData(fileName) {
    const file = this.storageBucket.file(fileName);
    return file.delete();
}

/**
 * Deletes the oldest objects in a bucket
 *
 * @param {String}        folder       - The folder in which object are stored
 * @param {Number}        maxCopies    - Maximum number of object to keep
 * @param {String}        [filePrefix] - Common prefix for files. Default is to examine full file name
 */
function deleteOldestObjects(folder, maxCopies) {
    logger.silly('deleting oldest objects');

    const options = {
        prefix: folder
    };

    return this.storageBucket.getFiles(options)
        .then((data) => {
            const files = data[0] || [];
            const metadataPromises = [];

            if (files.length > maxCopies) {
                files.forEach((file) => {
                    metadataPromises.push(file.getMetadata());
                });
            }

            return q.all(metadataPromises);
        })
        .then((results) => {
            const deletePromises = [];

            // Get metadata (position zero in result: result[0]) from results
            const metadataResults = results.map((result) => {
                return result[0];
            }) || [];

            // Sort so that oldest is first
            metadataResults.sort((a, b) => {
                const aUpdated = new Date(a.updated);
                const bUpdated = new Date(b.updated);
                if (aUpdated < bUpdated) {
                    return -1;
                } else if (bUpdated < aUpdated) {
                    return 1;
                }
                return 0;
            });

            for (let i = 0; i < metadataResults.length - maxCopies; i++) {
                deletePromises.push(deleteData.call(this, metadataResults[i].name));
            }

            return q.all(deletePromises);
        })
        .catch((err) => {
            logger.info('Error deleting old UCS files', err);
            return q.reject(err);
        });
}

function getData(fileName, options) {
    let file;
    if (options && options.bucket) {
        file = this.storage
            .bucket(options.bucket)
            .file(fileName);
    } else {
        file = this.storageBucket.file(fileName);
    }
    let fileData;

    return file.download()
        .then((downloadResponse) => {
            fileData = downloadResponse[0];
            return file.getMetadata();
        })
        .then((metadataResponse) => {
            const metadata = metadataResponse[0];
            const contentType = metadata.contentType || '';
            switch (contentType) {
            case 'application/octet-stream':
                return fileData;
            case 'application/json':
                return JSON.parse(fileData);
            default:
                return fileData.toString();
            }
        })
        .catch((err) => {
            this.logger.info('getData error', err && err.message ? err.message : err);
            return q.reject(err);
        });
}

function putData(fileName, data) {
    const file = this.storageBucket.file(fileName);
    const metadata = {};
    const deferred = q.defer();

    if (data instanceof stream.Readable) {
        data.pipe(file.createWriteStream({
            contentType: 'application/octet-stream'
        }))
            .on('error', (err) => {
                logger.info('putData error', err && err.message ? err.message : err);
                deferred.reject(err);
            })
            .on('finish', () => {
                deferred.resolve();
            });
    } else {
        let dataToWrite;
        if (typeof data !== 'string') {
            dataToWrite = JSON.stringify(data);
            metadata.contentType = 'application/json';
        } else {
            dataToWrite = data;
            metadata.contentType = 'text/plain';
        }

        return file.save(
            dataToWrite,
            {
                metadata,
                resumable: false
            }
        )
            .then(() => {
                deferred.resolve();
            })
            .catch((err) => {
                logger.info('putData error', err && err.message ? err.message : err);
                deferred.reject(err);
            });
    }
    return deferred.promise;
}

function getJoinTopicName() {
    return JOIN_PREFIX + this.providerOptions.instanceGroup;
}

function getSyncTopicName() {
    return SYNC_COMPLETE_PREFIX + this.providerOptions.instanceGroup;
}

function getJoinSubscriptionName() {
    return JOIN_PREFIX + this.instanceId;
}

function getSyncSubscriptionName() {
    return SYNC_COMPLETE_PREFIX + this.instanceId;
}

/**
 * Gets zone from zoneId.
 *
 * zoneId is in the format 'projects/734288666861/zones/us-west1-a'
 *
 * @param {String} zoneId - Zone id as returned from metadata
 */
function getZoneFromMetadataZone(zoneId) {
    const index = zoneId.lastIndexOf('/');
    if (index !== -1) {
        return zoneId.substr(index + 1);
    }
    return zoneId;
}

/**
 * Sets up topics and topics and subscriptions
 *
 *     + creates topics if they do not exist
 *     + subscribes to topics based on whether or not we are primary
 *
 * @param {Boolean} isPrimary - whether or not this instance is primary
 *
 * @returns {Promise} A promise that is resolved when done or rejected
 *                    if an error occurs.
 */
function setupTopicsAndSubscriptions(isPrimary) {
    this.logger.silly('setting up topics and subscriptions');

    const syncTopicName = getSyncTopicName.call(this);
    const joinTopicName = getJoinTopicName.call(this);

    return this.pubSub.getTopics()
        .then((data) => {
            const topics = data[0] || [];
            const promises = [];

            let hasSyncTopic = false;
            let hasJoinTopic = false;

            topics.forEach((topic) => {
                this.logger.silly('found topic', topic.name);
                if (topic.name.endsWith(syncTopicName)) {
                    this.logger.silly('found sync topic', topic.name);
                    hasSyncTopic = true;
                }
                if (topic.name.endsWith(joinTopicName)) {
                    this.logger.silly('found join topic', topic.name);
                    hasJoinTopic = true;
                }
            });

            if (!hasSyncTopic) {
                this.logger.silly('creating sync topic', syncTopicName);
                promises.push(
                    this.pubSub.createTopic(syncTopicName)
                );
            }

            if (!hasJoinTopic) {
                this.logger.silly('creating join topic', joinTopicName);
                promises.push(
                    this.pubSub.createTopic(joinTopicName)
                );
            }

            return q.all(promises);
        })
        .then(() => {
            if (isPrimary) {
                return this.pubSub.getSubscriptions({ topic: joinTopicName });
            }
            return this.pubSub.getSubscriptions({ topic: syncTopicName });
        })
        .then((data) => {
            const subscriptions = data[0] || [];
            const options = {
                messageRetentionDuration: '3600s'
            };

            const syncSubscriptionName = getSyncSubscriptionName.call(this);
            const joinSubscriptionName = getJoinSubscriptionName.call(this);

            let hasJoinSubscription = false;
            let hasSyncSubscritpion = false;

            subscriptions.forEach((subscription) => {
                this.logger.silly('found subscription', subscription);
                if (subscription.endsWith(joinSubscriptionName)) {
                    hasJoinSubscription = true;
                }
                if (subscription.endsWith(syncSubscriptionName)) {
                    hasSyncSubscritpion = true;
                }
            });

            // if we are primary, subscribe to join requests
            if (isPrimary && !hasJoinSubscription) {
                this.logger.silly('creating join subscription');
                return this.pubSub.createSubscription(
                    joinTopicName,
                    joinSubscriptionName,
                    options
                );
            }

            if (!isPrimary && !hasSyncSubscritpion) {
                this.logger.silly('creating sync subscription');
                // otherwise, subscribe to sync complete messages
                return this.pubSub.createSubscription(
                    syncTopicName,
                    syncSubscriptionName,
                    options
                );
            }

            return q();
        })
        .catch((err) => {
            this.logger.info('setupTopicsAndSubscriptions error:', err && err.message ? err.message : err);
            return q.reject(err);
        });
}

module.exports = GceCloudProvider;

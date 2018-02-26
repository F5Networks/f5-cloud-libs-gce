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

const util = require('util');
const q = require('q');

const compute = require('@google-cloud/compute');

const AbstractAutoscaleProvider = require('@f5devcentral/f5-cloud-libs').autoscaleProvider;
const Logger = require('@f5devcentral/f5-cloud-libs').logger;
const cloudUtil = require('@f5devcentral/f5-cloud-libs').util;

let logger;

util.inherits(GceAutoscaleProvider, AbstractAutoscaleProvider);

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
function GceAutoscaleProvider(options) {
    GceAutoscaleProvider.super_.call(this, options);

    const loggerOptions = options ? options.loggerOptions : undefined;

    logger = options ? options.logger : undefined;

    if (logger) {
        this.logger = logger;
        cloudUtil.setLogger(logger);
    } else if (loggerOptions) {
        loggerOptions.module = module;
        logger = Logger.getLogger(loggerOptions);
        cloudUtil.setLoggerOptions(loggerOptions);
        this.logger = logger;
    } else {
        // use super's logger
        logger = this.logger;
        cloudUtil.setLogger(logger);
    }

    this.compute = compute();
}

/**
 * Initialize class
 *
 * Override for implementation specific initialization needs (read info
 * from cloud provider, read database, etc.). Called at the start of
 * processing.
 *
 * @param {Object}  [providerOptions]         - Provider specific options.
 * @param {String}  [providerOptions.region]  - Region to use for searching instances.
 *
 * @returns {Promise} A promise which will be resolved when init is complete.
 */
GceAutoscaleProvider.prototype.init = function init(providerOptions) {
    const options = {
        headers: {
            'Metadata-Flavor': 'Google'
        }
    };

    // If we weren't given a region, get region we are in from metadata service
    this.region = providerOptions ? providerOptions.region : undefined;

    if (!this.region) {
        return cloudUtil.getDataFromUrl(
            'http://metadata.google.internal/computeMetadata/v1/instance/zone',
            options
        )
            .then((data) => {
                // zone info is in the format 'projects/734288666861/zones/us-west1-a', so grab the part
                // after the last '/''
                const parts = data.split('/');
                const zone = parts[parts.length - 1];

                // In a region, zones can talk to each other, so grab region
                this.region = getRegionFromZone(zone);

                logger.silly('region:', this.region);
            });
    }

    logger.silly('region:', this.region);
    return q();
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
GceAutoscaleProvider.prototype.getNicsByTag = function getNicsByTag() {
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
GceAutoscaleProvider.prototype.getVmsByTag = function getVmsByTag(tag) {
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
            let publicIp;
            let nic;

            const computeVms = data !== undefined ? data : [[]];

            computeVms[0].forEach((vm) => {
                if (getRegionFromZone(vm.zone.id) === this.region) {
                    if (vm.metadata && vm.metadata.networkInterfaces[0]) {
                        nic = vm.metadata.networkInterfaces[0];
                        if (nic.accessConfigs && nic.accessConfigs[0] && nic.accessConfigs[0].natIP) {
                            publicIp = nic.accessConfigs[0].natIP;
                        }
                        vms.push(
                            {
                                id: vm.id,
                                ip: {
                                    public: publicIp,
                                    private: nic.networkIP
                                }
                            }
                        );
                    }
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
 * Gets the zone from a region.
 *
 * For example, 'us-west1-a' returns 'us-west1'
 */
function getRegionFromZone(zone) {
    return zone.substr(0, zone.lastIndexOf('-'));
}

module.exports = GceAutoscaleProvider;

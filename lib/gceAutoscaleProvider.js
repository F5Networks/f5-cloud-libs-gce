/**
* Copyright 2017 F5 Networks, Inc.
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

var util = require('util');
var q = require('q');

var compute = require('@google-cloud/compute');

var AbstractAutoscaleProvider;
var Logger;
var logger;

// In production we should be installed as a node_module under f5-cloud-libs
// In test, that will not be the case, so use our dev dependency version
// of f5-cloud-libs
try {
    AbstractAutoscaleProvider = require('../../../../f5-cloud-libs').autoscaleProvider;
    Logger = require('../../../../f5-cloud-libs').logger;
}
catch (err) {
    AbstractAutoscaleProvider = require('f5-cloud-libs').autoscaleProvider;
    Logger = require('f5-cloud-libs').logger;
}

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
* @param {Object} [options.loggerOptions] - Options for the logger. See {@link module:logger.getLogger} for details.
*/
function GceAutoscaleProvider(options) {
    GceAutoscaleProvider.super_.call(this, options);
    options = options || {};
    if (options.logger) {
        logger = this.logger = options.logger;
    }
    else if (options.loggerOptions) {
        options.loggerOptions.module = module;
        logger = this.logger = Logger.getLogger(options.loggerOptions);
    }

    this.compute = compute();
}

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
GceAutoscaleProvider.prototype.getNicsByTag = function() {
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
GceAutoscaleProvider.prototype.getVmsByTag = function(tag) {
    var deferred = q.defer();
    var vms = [];
    var options;

    if (!tag || !tag.key || !tag.value) {
        deferred.reject(new Error('Tag with key and value must be provided'));
        return deferred.promise;
    }

    // Labels in GCE must be lower case
    options = {
        filter: "labels." + tag.key.toLowerCase() + " eq " + tag.value.toLowerCase()
    };

    this.compute.getVMs(options)
        .then(function(data) {
            var publicIp;
            var nic;

            data = data || [[]];
            data[0].forEach(function(vm) {
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
            });

            deferred.resolve(vms);
        }.bind(this))
        .catch(function(err) {
            deferred.reject(err);
        });

    return deferred.promise;
};

module.exports = GceAutoscaleProvider;
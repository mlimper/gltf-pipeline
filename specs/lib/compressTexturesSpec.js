'use strict';
var Cesium = require('cesium');
var child_process = require('child_process');
var clone = require('clone');
var dataUriToBuffer = require('data-uri-to-buffer');
var fsExtra = require('fs-extra');
var path = require('path');
var Promise = require('bluebird');
var compressTextures = require('../../lib/compressTextures');
var loadKTX = require('../../lib/loadKTX');
var Pipeline = require('../../lib/Pipeline');

var fsExtraReadJson = Promise.promisify(fsExtra.readJson);
var fsExtraStat = Promise.promisify(fsExtra.stat);

var defined = Cesium.defined;
var DeveloperError = Cesium.DeveloperError;

var basePath = './specs/data/boxTexturedUnoptimized/';
var gltfPath = './specs/data/boxTexturedUnoptimized/CesiumTexturedBoxTest.gltf';
var gltfEmbeddedPath = './specs/data/boxTexturedUnoptimized/CesiumTexturedBoxTestEmbedded.gltf';

// Defined relative to the gltf
var jpgPath = 'Cesium_Logo_Flat.jpg';
var pngPath = 'Cesium_Logo_Flat.png';
var gifPath = 'Cesium_Logo_Flat.gif';
var transparentPath = 'Cesium_Logo_Flat_Transparent.png';

// etc2comp only supports png input so this is a good test case for handling different input image formats
var etc1Compression = {
    format : 'etc1'
};

function compressTexture(gltfPath, imagePath, options) {
    return fsExtraReadJson(gltfPath)
        .then(function(gltf) {
            if (defined(imagePath)) {
                gltf.images.Image0001.uri = imagePath;
            }
            options.enable = true;
            var pipelineOptions = {
                textureCompressionOptions : options,
                basePath : basePath
            };
            return Pipeline.processJSON(gltf, pipelineOptions)
                .then(function(gltf) {
                    var imageUri = gltf.images.Image0001.uri;
                    var imageBuffer = dataUriToBuffer(imageUri);

                    if (options.format.indexOf('crunch') >= 0) {
                        expect(imageUri.indexOf('image/crn') >= 0).toBe(true);
                        // TODO : inspect crunch file
                    } else {
                        expect(imageUri.indexOf('image/ktx') >= 0).toBe(true);
                        return loadKTX(imageBuffer)
                            .then(function(ktxData) {
                                // Original image is 211x211. It will be shrunk to the lower power-of-two
                                expect(ktxData.width).toBe(128);
                                expect(ktxData.height).toBe(128);
                                console.log(ktxData.format);
                            });
                    }
                });
        });
}

function directoryExists(directory) {
    return fsExtraStat(directory)
        .then(function(stats) {
            return stats.isDirectory();
        })
        .catch(function(err) {
            // If the directory doesn't exist the error code is ENOENT.
            // Otherwise something else went wrong - permission issues, etc.
            if (err.code !== 'ENOENT') {
                throw err;
            }
            return false;
        });
}


describe('compressTextures', function() {
    fit('compresses external jpg', function(done) {
        expect(compressTexture(gltfPath, jpgPath, etc1Compression), done).toResolve();
    });

    it('compresses external png', function(done) {
        expect(compressTexture(gltfPath, pngPath, etc1Compression), done).toResolve();
    });

    it('throws when compressing external gif', function(done) {
        // gif files cannot be decoded with Jimp and are not accepted by most compress tools
        var errorMessage = 'The input image format "gif" is not supported for texture compression.';
        expect(compressTexture(gltfPath, gifPath, etc1Compression), done).toRejectWith(DeveloperError, errorMessage);
    });

    it('compresses embedded png', function(done) {
        expect(compressTexture(gltfEmbeddedPath, undefined, etc1Compression), done).toResolve();
    });

    it('throws with undefined gltf', function() {
        expect(function() {
            compressTextures();
        }).toThrowDeveloperError();
    });

    it('throws with undefined format', function() {
        var gltf = {};
        expect(function() {
            compressTextures(gltf);
        }).toThrowDeveloperError();
    });

    it('throws with invalid format', function() {
        var gltf = {};
        var options = {
            format : 'invalid-format'
        };
        expect(function() {
            compressTextures(gltf, options);
        }).toThrowDeveloperError();
    });

    it('throws with invalid quality', function() {
        var gltf = {};
        var options = {
            format : 'etc1',
            quality : 11
        };
        expect(function() {
            compressTextures(gltf, options);
        }).toThrowDeveloperError();
    });

    it('throws with invalid pvrtc bitrate', function() {
        var gltf = {};
        var options = {
            format : 'pvrtc1',
            bitrate : 3.0
        };
        expect(function() {
            compressTextures(gltf, options);
        }).toThrowDeveloperError();
    });

    it('throws with invalid astc block size', function() {
        var gltf = {};
        var options = {
            format : 'astc',
            blockSize : '1x1'
        };
        expect(function() {
            compressTextures(gltf, options);
        }).toThrowDeveloperError();
    });

    it('tempDirectory is removed when compression succeeds', function(done) {
        spyOn(fsExtra, 'writeFile').and.callThrough();
        expect(compressTexture(gltfPath, undefined, etc1Compression)
            .then(function() {
                var tempDirectory = path.dirname(fsExtra.writeFile.calls.argsFor(0)[0]);
                console.log(tempDirectory);
                return directoryExists(tempDirectory)
                    .then(function(exists) {
                        expect(exists).toBe(false);
                    });
            }), done).toResolve();
    });

    it('tempDirectory is removed when compression fails', function(done) {
        spyOn(fsExtra, 'writeFile').and.callThrough();
        spyOn(child_process, 'spawn').and.callFake(function(command, args) {
            // Trigger a failure by sending in an invalid argument to the compress tool
            args.push('invalid_arg');
            return child_process.spawn(command, args);
        });
        expect(compressTexture(gltfPath, undefined, etc1Compression)
            .then(function() {
                var tempDirectory = path.dirname(fsExtra.writeFile.calls.argsFor(0)[0]);
                return directoryExists(tempDirectory)
                    .then(function(exists) {
                        expect(exists).toBe(false);
                    });
            }), done).toRejectWith(DeveloperError);
    });

});

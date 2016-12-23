'use strict';
var Cesium = require('cesium');
var child_process = require('child_process');
var fsExtra = require('fs-extra');
var Jimp = require('jimp');
var os = require('os');
var path = require('path');
var Promise = require('bluebird');
var uuid = require('uuid');

Jimp.prototype.getBufferAsync = Promise.promisify(Jimp.prototype.getBuffer);
var fsExtraEnsureDir = Promise.promisify(fsExtra.ensureDir);
var fxExtraReadFile = Promise.promisify(fsExtra.readFile);
var fsExtraRemove = Promise.promisify(fsExtra.remove);
var fsExtraWriteFile = Promise.promisify(fsExtra.outputFile);

var CesiumMath = Cesium.Math;
var combine = Cesium.combine;
var defaultValue = Cesium.defaultValue;
var defined = Cesium.defined;
var DeveloperError = Cesium.DeveloperError;

module.exports = compressTextures;

var pvrTexToolExtensions = ['.jpeg', '.jpg', '.png', '.bmp'];
var etc2compExtensions = ['.png'];
var crunchExtensions = ['.jpeg', '.jpg', '.png', '.bmp'];
var astcencExtensions = ['.jpeg', '.jpg', '.png', '.bmp', '.gif'];

var compressToolDirectory = path.join(__dirname, '../bin/', os.platform());
var pvrTexToolPath = path.join(compressToolDirectory, 'PVRTexToolCLI');
var etc2compPath = path.join(compressToolDirectory, 'EtcTool');
var crunchPath = path.join(compressToolDirectory, 'crunch');
var astcencPath = path.join(compressToolDirectory, 'astcenc');

var formats = ['pvrtc1', 'pvrtc2', 'etc1', 'etc2', 'astc', 'dxt1', 'dxt3', 'dxt5', 'crunch-dxt1', 'crunch-dxt3', 'crunch-dxt5'];
var astcBlockSizes = ['4x4', '5x4', '5x5', '6x5', '6x6', '8x5', '8x6', '8x8', '10x5', '10x6', '10x8', '10x10', '12x10', '12x12'];

/**
 * Compress textures in the glTF model.
 *
 * @param {Object} gltf A javascript object containing a glTF asset.
 * @param {Object} options Options defining custom behavior:
 * @param {String} options.format The compressed texture format. Supported formats are 'pvrtc1', 'pvrtc2', 'etc1', 'etc2', 'astc', 'dxt1', 'dxt3', 'dxt5', 'crunch-dxt1', 'crunch-dxt3', 'crunch-dxt5'.
 * @param {Number} [options.quality=5] A value between 0 and 10 specifying the quality of the compressed textures. Higher values produce better quality compression but take longer to compute. Different texture formats and compress tools may treat this value differently.
 * @param {Number} [options.bitrate=2.0] The bits-per-pixel when using the pvrtc or astc formats. For pvrtc supported values are 2.0 and 4.0.
 * @param {String} [options.blockSize='8x8'] The block size for astc compression. Smaller block sizes result in higher bitrates. This value is ignored if options.bitrate is also set. Supported block sizes are '4x4', '5x4', '5x5', '6x5', '6x6', '8x5', '8x6', '8x8', '10x5', '10x6', '10x8', '10x10', '12x10', '12x12'.
 * @param {Boolean} [options.alphaBit=false] Store a single bit for alpha. Not supported for all formats or compress tools.
 * @returns {Promise} A promise that resolves to the glTF asset with embedded compressed textures.
 *
 * @see addPipelineExtras
 * @see loadGltfUris
 */
function compressTextures(gltf, options) {
    options = defaultValue(options, {});

    if (!defined(gltf)) {
        throw new DeveloperError('gltf must be defined');
    }

    var format = options.format;
    if (!defined(format)) {
        throw new DeveloperError('options.format must be defined.');
    }

    if (!formats.includes(format)) {
        throw new DeveloperError('format "' + format + '" is not a supported format. Supported formats are ' + formats.join(', ') + '.');
    }

    // Set defaults
    options.quality = defaultValue(options.quality, 5);
    options.bitrate = defaultValue(options.bitrate, 2.0);
    options.blockSize = defaultValue(options.blockSize, '8x8'); // 8x8 corresponds to 2.0 bpp for astc
    options.alphaBit = defaultValue(options.alphaBit, false);

    if (options.quality < 0 || options.quality > 10) {
        throw new DeveloperError('Quality must be between 0 and 10.');
    }

    if ((format === 'pvrtc1' || format === 'pvrtc2') && options.bitrate !== 2 && options.bitrate !== 4) {
        throw new DeveloperError('bitrate (bits-per-pixel) must be 2 or 4 when using pvrtc.');
    }

    if (format === 'astc' && !astcBlockSizes.includes(options.blockSize)) {
        throw new DeveloperError('Block size "' + options.blockSize + '" is not supported. Supported values are ' + astcBlockSizes.join(', ') + '.');
    }

    // Choose the compress tool to use
    var inputExtensions;
    var compressFunction;
    var resizeToPowerOfTwo = false;

    if (format === 'pvrtc1' || format === 'pvrtc2') {
        // PVRTC hardware support rectangular power-of-two, but iOS software requires square power-of-two.
        // PVRTexTool has a CLI option for resizing to square power-of-two.
        inputExtensions = pvrTexToolExtensions;
        compressFunction = compressWithPVRTexTool;
    } else if (format === 'etc1' || format === 'etc2') {
        // https://www.khronos.org/registry/webgl/extensions/WEBGL_compressed_texture_etc/
        // According to the WEBGL_compressed_texture_etc extension, the size of the image data must be equivalent to
        // floor((width + 3) / 4) * floor((height + 3) / 4) * 8
        // For simplicity just round to the lower power-of-two. etc2comp does not have a resize option so resize with Jimp.
        inputExtensions = etc2compExtensions;
        compressFunction = compressWithEtc2comp;
        resizeToPowerOfTwo = true;
    } else if (format === 'dxt1' || format === 'dxt3' || format === 'dxt5' || format === 'crunch-dxt1' || format === 'crunch-dxt3' || format === 'crunch-dxt5') {
        // DXT has a multiple-of-four requirement. Crunch has a CLI option for resizing to power-of-two.
        inputExtensions = crunchExtensions;
        compressFunction = compressWithCrunch;
    } else if (format === 'astc') {
        // https://www.opengl.org/registry/specs/KHR/texture_compression_astc_hdr.txt
        // According to KHR_texture_compression_astc_hdr extension, width and height of each sub-image must be a
        // multiple of the block size. Astcenc does not have a resize option so resize with Jimp.
        // TODO : ktx output not supported, need a JS KTX writer before this format is ready.
        inputExtensions = astcencExtensions;
        compressFunction = compressWithAstcenc;
        resizeToPowerOfTwo = true;
    }

    // Save images to a temp directory. The compressed image will be read into the pipeline extras.
    var tempDirectory = getTempDirectory();

    var promises = [];
    var images = gltf.images;
    for (var imageId in images) {
        if (images.hasOwnProperty(imageId)) {
            var image = images[imageId];
            var pipelineExtras = image.extras._pipeline;
            var absolutePath = pipelineExtras.absolutePath;
            var jimpImage = pipelineExtras.jimpImage;
            var source = pipelineExtras.source;
            var transparent = pipelineExtras.transparent;
            var extension = pipelineExtras.extension;
            var imageChanged = pipelineExtras.imageChanged;
            var compressOptions = combine(options, {
                transparent : transparent
            });
            var promise;
            if (resizeToPowerOfTwo || imageChanged || !inputExtensions.includes(extension)) {
                // Several cases where the raw image data is needed:
                // * If the image needs to be resized
                // * If the image has changed since the gltf was loaded. (e.g. when baking AO into a texture)
                // * If the original image is not a supported extension for the compress tool
                // If the raw image data does not exist then it means the original image is not a
                // supported format - for example gif, ktx, dds, and others.
                if (!defined(jimpImage)) {
                    throw new DeveloperError('The input image format "' + format + '" is not supported for texture compression.');
                }
                if (resizeToPowerOfTwo) {
                    var width = jimpImage.bitmap.width;
                    var height = jimpImage.bitmap.height;
                    if (!CesiumMath.isPowerOfTwo(width) || !CesiumMath.isPowerOfTwo(height)) {
                        width = previousPowerOfTwo(width);
                        height = previousPowerOfTwo(height);
                        jimpImage.resize(width, height);
                    }
                }
                promise = compressJimpImage(jimpImage, tempDirectory, compressFunction, compressOptions);
            } else {
                if (defined(absolutePath)) {
                    // The external image can be sent directly to the compression tool
                    promise = compressFile(absolutePath, tempDirectory, compressFunction, compressOptions);
                } else {
                    // The embedded image can be saved as-is and then sent to the compression tool
                    promise = compressBuffer(source, extension, tempDirectory, compressFunction, compressOptions);
                }
            }
            promises.push(promise.then(replaceImage(image)));
        }
    }

    return fsExtraEnsureDir(tempDirectory)
        .then(function() {
            return Promise.all(promises)
                .finally(function() {
                    fsExtraRemove(tempDirectory);
                });
        });
}

function previousPowerOfTwo(n) {
    n = n | (n >> 1);
    n = n | (n >> 2);
    n = n | (n >> 4);
    n = n | (n >> 8);
    n = n | (n >> 16);
    return n - (n >> 1);
}

function replaceImage(image) {
    return function(compressed) {
        var pipelineExtras = image.extras._pipeline;
        pipelineExtras.source = compressed.buffer;
        pipelineExtras.extension = compressed.extension;
    };
}

function getTempDirectory() {
    var tempDirectory = os.tmpdir();
    var randomId = uuid.v4();
    return path.join(tempDirectory, randomId);
}

function getTempImagePath(tempDirectory, extension) {
    var randomId = uuid.v4();
    return path.join(tempDirectory, randomId + extension);
}

function createProcess(compressToolPath, options) {
    return new Promise(function (resolve, reject) {
        var child = child_process.spawn(compressToolPath, options);
        child.once('error', function (e) {
            reject(e);
        });
        child.once('exit', function (code) {
            if (code !== 0) {
                reject('Converter tool exited with an error code of ' + code);
            } else {
                resolve();
            }
        });
    });
}

function compressJimpImage(jimpImage, tempDirectory, compressFunction, options) {
    // Encode image as png since this is supported by all the compress tools
    return jimpImage.getBufferAsync(Jimp.MIME_PNG)
        .then(function(buffer) {
            return compressBuffer(buffer, '.png', tempDirectory, compressFunction, options);
        });
}

function compressBuffer(buffer, extension, tempDirectory, compressFunction, options) {
    // Save temporary image file off to a temp directory
    var inputPath = getTempImagePath(tempDirectory, extension);
    return fsExtraWriteFile(inputPath, buffer)
        .then(function() {
            return compressFile(inputPath, tempDirectory, compressFunction, options);
        });
}

function compressFile(inputPath, tempDirectory, compressFunction, options) {
    var extension = '.ktx';
    if (options.format.indexOf('crunch') >= 0) {
        // Crunch cannot be embedded in a ktx file
        extension = '.crn';
    }
    var outputPath = getTempImagePath(tempDirectory, extension);
    var cli = compressFunction(inputPath, outputPath, options);
    return createProcess(cli.path, cli.options)
        .then(function() {
            return fxExtraReadFile(outputPath)
                .then(function(buffer) {
                    return {
                        buffer : buffer,
                        extension : extension
                    };
                });
        });
}

function compressWithEtc2comp(inputPath, outputPath, options) {
    var quality = options.quality * 10.0; // Map quality to a 0-100 range
    var format = options.format;
    var transparent = options.transparent;
    var alphaBit = options.alphaBit;

    var cliFormat;
    if (format === 'etc1') {
        cliFormat = 'ETC1';
    } else if (format === 'etc2') {
        if (transparent && alphaBit) {
            cliFormat = 'RGB8A1';
        } else if (transparent && !alphaBit) {
            cliFormat = 'RGBA8';
        } else if (!transparent) {
            cliFormat = 'RGB8';
        }
    }

    var cpuCount = os.cpus().length;
    var cliOptions = [inputPath, '-format', cliFormat, '-effort', quality, '-jobs', cpuCount, '-output', outputPath];

    return {
        path : etc2compPath,
        options : cliOptions
    };
}

function compressWithPVRTexTool(inputPath, outputPath, options) {
    var format = options.format;
    var quality = Math.floor(options.quality / 2.1); // Map quality to a 0-4 scale
    var bitrate = options.bitrate;
    var transparent = options.transparent;

    var qualityOptions = ['pvrtcfastest', 'pvrtcfast', 'pvrtcnormal', 'pvrtchigh', 'pvrtcbest'];
    var cliQuality = qualityOptions[quality];
    var cliFormat;

    if (format === 'pvrtc1') {
        // TODO : Any setting for RGB+A1?
        if (transparent && bitrate === 2) {
            cliFormat = 'PVRTC1_2';
        } else if (transparent && bitrate === 4) {
            cliFormat ='PVRTC1_4';
        } else if (!transparent && bitrate === 2) {
            cliFormat = 'PVRTC1_2_RGB';
        } else if (!transparent && bitrate === 4) {
            cliFormat = 'PVRTC1_4_RGB';
        }
    } else if (format === 'pvrtc2') {
        // TODO : Any setting for RGB, RGBA, RGB+A1?
        if (bitrate === 2) {
            cliFormat = 'PVRTC2_2';
        } else if (bitrate === 4) {
            cliFormat = 'PVRTC2_4';
        }
    }

    // No CPU count - this tool is single-threaded
    var cliOptions = ['-i', inputPath, '-o', outputPath, '-f', cliFormat, '-q', cliQuality, '-square', '-', '-pot', '-'];

    return {
        path : pvrTexToolPath,
        options : cliOptions
    };
}

function compressWithCrunch(inputPath, outputPath, options) {
    // Clustered DXTc compression is not yet supported for .ktx files.
    // For .crn and .dds, these values can be controlled by the CLI options -quality and -bitrate.
    var quality = Math.floor(options.quality / 2.1); // Map quality to a 0-4 scale
    var format = options.format;
    var transparent = options.transparent;

    var dxtQualityOptions = ['superfast', 'fast', 'normal', 'better', 'uber'];
    var dxtQuality = dxtQualityOptions[quality];

    var cliFormat;
    var fileFormat;

    if (format.indexOf('crunch') >= 0) {
        fileFormat = 'crn';
        format = format.slice(7);
    } else {
        fileFormat = 'ktx';
    }

    if (format === 'dxt1') {
        if (transparent) {
            cliFormat = '-DXT1A';
        } else {
            cliFormat = '-DXT1';
        }
    } else if (format === 'dxt3') {
        cliFormat = '-DXT3';
    } else if (format === 'dxt5') {
        cliFormat = '-DXT5';
    }

    var cpuCount = os.cpus().length;
    var cliOptions = ['-file', inputPath, '-out', outputPath, '-fileformat', fileFormat, '-helperThreads', cpuCount, '-dxtQuality', dxtQuality, '-rescalemode', 'lo', '-mipMode', 'None', cliFormat];
    return {
        path : crunchPath,
        options : cliOptions
    };
}

function numberToString(number) {
    if (number % 1 === 0) {
        // Add a .0 to whole numbers
        return number.toFixed(1);
    } else {
        return number.toString();
    }
}

function compressWithAstcenc(inputPath, outputPath, options) {
    // TODO : Any setting for RGB, RGBA, RGB+A1?
    // TODO : This tool has many low-level adjustment controls, but probably not worth exposing unless needed.
    var quality = Math.floor(options.quality / 2.1); // Map quality to a 0-4 scale
    var bitrate = options.bitrate;
    var blockSize = options.blockSize;
    var transparent = options.transparent;

    var qualityOptions = ['-veryfast', '-fast', '-medium', '-thorough', '-exhaustive'];
    var cliQuality = qualityOptions[quality];

    var cliRate;
    if (bitrate !== 2.0) {
        // Use the bitrate instead of the block-size. 2.0 is the default.
        // astcenc requires bitrates to have at least one actual decimal
        cliRate = numberToString(bitrate);
    } else {
        cliRate = blockSize;
    }

    var cpuCount = os.cpus().length;
    var cliOptions = ['-cl', inputPath, outputPath, cliRate, '-j', cpuCount, cliQuality];

    if (transparent) {
        // TODO : verify if this is needed / correct
        cliOptions.push('-alphablend');
    }

    return {
        path : astcencPath,
        options : cliOptions
    };
}

/**
 * Vision / Screen Understanding Skill (Part 5)
 * ------------------------------------------------------------------
 * Understands uploaded images, analyzes screenshots, and explains diagrams
 * where practical in the browser:
 *   - image dimensions, dominant colours, brightness/contrast
 *   - screenshot capture via the Screen Capture API (permission-gated)
 *
 * This runs entirely locally (Canvas API) — no external vision service, so
 * it is free, private, and works offline. Real OCR/object recognition would
 * be a drop-in extension of this skill (see manifest.permissions).
 */
import { state } from '../state.js';

export const vision = {
    name: 'vision',
    description: 'Analyzes images, screenshots, and diagrams',
    risk: 'safe',
    permissions: ['camera', 'screen-capture', 'image-input'],
    inputs: [
        { name: 'image', type: 'file', description: 'Image to analyze (optional)' }
    ],
    actions: ['analyze', 'screenshot'],
    patterns: [
        /analy[sz]e\s+(?:this\s+)?(?:image|picture|photo|screenshot|diagram)/i,
        /(?:what|tell\s+me)\s+(?:is|about)\s+(?:in\s+|on\s+)?(?:this\s+)?(?:image|picture|photo|screenshot|diagram)/i,
        /explain\s+(?:this\s+)?(?:diagram|image|picture|photo)/i,
        /take\s+a\s+screenshot/i,
        /capture\s+(?:the\s+)?screen/i,
        /look\s+at\s+(?:this\s+)?(?:image|picture|photo|screen)/i
    ],

    async execute(input, context = {}) {
        const text = input.toLowerCase();

        if (text.includes('screenshot') || text.includes('capture')) {
            return this._screenshot();
        }

        return this._analyzeImage();
    },

    /**
     * Prompt the user to select an image, then analyze it locally.
     */
    _analyzeImage() {
        const inputEl = document.createElement('input');
        inputEl.type = 'file';
        inputEl.accept = 'image/*';

        inputEl.onchange = async (e) => {
            const file = e.target.files && e.target.files[0];
            if (!file) return;
            try {
                const dataUrl = await this._readAsDataURL(file);
                const analysis = await this._analyzeDataUrl(dataUrl);
                state.logActivity(`Image analyzed: ${file.name} (${analysis.width}×${analysis.height})`, 'success');
                state.notify(`Image analyzed: ${file.name}`, 'success');
            } catch (err) {
                state.logActivity(`Image analysis failed: ${err.message}`, 'danger');
                state.notify(`Could not analyze image: ${err.message}`, 'danger');
            }
        };

        inputEl.click();

        return {
            success: true,
            interactive: true,
            result: 'Please select an image to analyze. I will inspect its dimensions, dominant colours, and brightness locally.'
        };
    },

    /**
     * Capture the screen using the Screen Capture API (requires permission).
     */
    async _screenshot() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
            return {
                success: false,
                error: 'Screen capture is not supported in this browser.'
            };
        }
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            const track = stream.getVideoTracks()[0];
            const video = document.createElement('video');
            video.srcObject = stream;
            await video.play();

            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0);

            track.stop();

            const dataUrl = canvas.toDataURL('image/png');
            const analysis = await this._analyzeDataUrl(dataUrl);

            return {
                success: true,
                result: `Captured screenshot (${analysis.width}×${analysis.height}). Dominant colour ${analysis.dominantColor}, brightness ${analysis.brightness}%.`
            };
        } catch (e) {
            return {
                success: false,
                error: 'Screen capture was cancelled or permission was denied.'
            };
        }
    },

    // ----- local image analysis helpers -----

    _readAsDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('could not read file'));
            reader.readAsDataURL(file);
        });
    },

    _loadImage(dataUrl) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('could not decode image'));
            img.src = dataUrl;
        });
    },

    async _analyzeDataUrl(dataUrl) {
        const img = await this._loadImage(dataUrl);

        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        const { width, height } = canvas;

        // Sample pixels for colour/brightness
        const sampleSize = Math.min(32, width);
        const stepX = Math.max(1, Math.floor(width / sampleSize));
        const stepY = Math.max(1, Math.floor(height / sampleSize));
        const colorBuckets = {};
        let totalBrightness = 0;
        let count = 0;

        for (let y = 0; y < height; y += stepY) {
            for (let x = 0; x < width; x += stepX) {
                const p = ctx.getImageData(x, y, 1, 1).data;
                const [r, g, b] = [p[0], p[1], p[2]];
                const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
                totalBrightness += brightness;
                count++;

                // Quantize to a coarse colour name
                const key = this._quantizeColor(r, g, b);
                colorBuckets[key] = (colorBuckets[key] || 0) + 1;
            }
        }

        const brightnessPct = Math.round((totalBrightness / count / 255) * 100);
        const dominantColor = Object.entries(colorBuckets)
            .sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';

        state.set('lastAnalyzedImage', {
            width, height, dominantColor, brightness: brightnessPct, at: Date.now()
        });

        return { width, height, dominantColor, brightness: brightnessPct };
    },

    _quantizeColor(r, g, b) {
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        if (max - min < 30) {
            if (max < 60) return 'black';
            if (max > 200) return 'white';
            return 'grey';
        }
        if (max === r) return g > 120 ? 'yellow' : (b > 120 ? 'magenta' : 'red');
        if (max === g) return r > 120 ? 'yellow' : (b > 120 ? 'cyan' : 'green');
        return b > 120 && r > 120 ? 'magenta' : 'blue';
    },

    onError(input, result) {
        // Friendly recovery hint when analysis fails
        return {
            success: false,
            error: `${result.error || 'Analysis failed'}. Please try a standard image format (PNG, JPEG, or GIF).`
        };
    }
};

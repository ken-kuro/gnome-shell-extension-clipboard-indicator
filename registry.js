import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import { PrefsFields } from './constants.js';

const FileQueryInfoFlags = Gio.FileQueryInfoFlags;
const FileCopyFlags = Gio.FileCopyFlags;
const FileTest = GLib.FileTest;

export class Registry {
    constructor ({ settings, uuid }) {
        this.uuid = uuid;
        this.settings = settings;
        this.REGISTRY_FILE = 'registry.txt';
        this.REGISTRY_DIR = GLib.get_user_cache_dir() + '/' + this.uuid;
        this.REGISTRY_PATH = this.REGISTRY_DIR + '/' + this.REGISTRY_FILE;
        this.BACKUP_REGISTRY_PATH = this.REGISTRY_PATH + '~';
    }

    write (entries) {
        const registryContent = [];

        for (let entry of entries) {
            const item = {
                favorite: entry.isFavorite(),
                mimetype: entry.mimetype()
            };

            registryContent.push(item);

            if (entry.isText()) {
                item.contents = entry.getStringValue();
            }
            else if (entry.isImage()) {
                const filename = this.getEntryFilename(entry);
                item.contents = filename;
                this.writeEntryFile(entry);
            }
        }

        this.writeToFile(registryContent);
    }

    writeToFile (registry) {
        let json = JSON.stringify(registry);
        let contents = new GLib.Bytes(json);

        // Make sure dir exists
        GLib.mkdir_with_parents(this.REGISTRY_DIR, parseInt('0775', 8));

        // Write contents to file asynchronously
        let file = Gio.file_new_for_path(this.REGISTRY_PATH);
        file.replace_async(null, false, Gio.FileCreateFlags.NONE,
                            GLib.PRIORITY_DEFAULT, null, (obj, res) => {

            let stream = obj.replace_finish(res);

            stream.write_bytes_async(contents, GLib.PRIORITY_DEFAULT,
                                null, (w_obj, w_res) => {

                w_obj.write_bytes_finish(w_res);
                stream.close(null);
            });
        });
    }

    read (callback) {
        if (typeof callback !== 'function')
            throw TypeError('`callback` must be a function');

        if (GLib.file_test(this.REGISTRY_PATH, FileTest.EXISTS)) {
            let file = Gio.file_new_for_path(this.REGISTRY_PATH);
            let CACHE_FILE_SIZE = this.settings.get_int(PrefsFields.CACHE_FILE_SIZE);

            file.query_info_async('*', FileQueryInfoFlags.NONE,
                                  GLib.PRIORITY_DEFAULT, null, (src, res) => {
                // Check if file size is larger than CACHE_FILE_SIZE
                // If so, make a backup of file, and invoke callback with empty array
                let file_info = src.query_info_finish(res);

                if (file_info.get_size() >= CACHE_FILE_SIZE * 1024 * 1024) {
                    let destination = Gio.file_new_for_path(this.BACKUP_REGISTRY_PATH);

                    file.move(destination, FileCopyFlags.OVERWRITE, null, null);
                    callback([]);
                    return;
                }

                file.load_contents_async(null, (obj, res) => {
                    let [success, contents] = obj.load_contents_finish(res);

                    if (success) {
                        let max_size = this.settings.get_int(PrefsFields.HISTORY_SIZE);
                        const registry = JSON.parse(new TextDecoder().decode(contents));
                        const entriesPromises = registry.map(
                            jsonEntry => {
                                return ClipboardEntry.fromJSON(jsonEntry)
                            }
                        );

                        Promise.all(entriesPromises).then(clipboardEntries => {
                            let registryNoFavorite = clipboardEntries.filter(
                                entry => entry.isFavorite()
                            );

                            while (registryNoFavorite.length > max_size) {
                                let oldestNoFavorite = registryNoFavorite.shift();
                                let itemIdx = clipboardEntries.indexOf(oldestNoFavorite);
                                clipboardEntries.splice(itemIdx,1);

                                registryNoFavorite = clipboardEntries.filter(
                                    entry => entry.isFavorite()
                                );
                            }

                            callback(clipboardEntries);
                        }).catch(e => {
                            console.error('CLIPBOARD INDICATOR ERROR');
                            console.error(e);
                        });
                    }
                    else {
                        console.error('Clipboard Indicator: failed to open registry file');
                    }
                });
            });
        }
        else {
            callback([]);
        }
    }

    #entryFileExists (entry) {
        const filename = this.getEntryFilename(entry);
        return GLib.file_test(filename, FileTest.EXISTS);
    }

    async getEntryAsImage (entry) {
        const filename = this.getEntryFilename(entry);

        if (entry.isImage() === false) return;

        if (this.#entryFileExists(entry) == false) {
            await this.writeEntryFile(entry);
        }

        const gicon = Gio.icon_new_for_string(this.getEntryFilename(entry));
        const stIcon = new St.Icon({ gicon });
        return stIcon;
    }

    getEntryFilename (entry) {
        return `${this.REGISTRY_DIR}/${entry.asBytes().hash()}`;
    }

    async writeEntryFile (entry) {
        if (this.#entryFileExists(entry)) return;

        let file = Gio.file_new_for_path(this.getEntryFilename(entry));

        return new Promise(resolve => {
            file.replace_async(null, false, Gio.FileCreateFlags.NONE,
                               GLib.PRIORITY_DEFAULT, null, (obj, res) => {

                let stream = obj.replace_finish(res);

                stream.write_bytes_async(entry.asBytes(), GLib.PRIORITY_DEFAULT,
                                         null, (w_obj, w_res) => {

                    w_obj.write_bytes_finish(w_res);
                    stream.close(null);
                    resolve();
                });
            });
        });
    }

    async deleteEntryFile (entry) {
        const file = Gio.file_new_for_path(this.getEntryFilename(entry));

        try {
            await file.delete_async(GLib.PRIORITY_DEFAULT, null);
        }
        catch (e) {
            console.error(e);
        }
    }
}

export class ClipboardEntry {
    #mimetype;
    #bytes;
    #favorite;

    static #decode (contents) {
        return Uint8Array.from(contents.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)));
    }

    static async fromJSON (jsonEntry) {
        const mimetype = jsonEntry.mimetype || 'text/plain';
        const favorite = jsonEntry.favorite;
        let bytes;

        if (mimetype.startsWith('text/')) {
            bytes = new TextEncoder().encode(jsonEntry.contents);
        }
        else {
            let file = Gio.file_new_for_path(jsonEntry.contents);
            bytes = await new Promise((resolve, reject) => file.load_contents_async(null, (obj, res) => {
                let [success, contents] = obj.load_contents_finish(res);

                if (success) {
                    resolve(contents);
                }
                else {
                    reject(
                        new Error('Clipboard Indicator: could not read image file from cache')
                    );
                }
            }));
        }

        return new ClipboardEntry(mimetype, bytes, favorite);
    }

    constructor (mimetype, bytes, favorite) {
        this.#mimetype = mimetype;
        this.#bytes = bytes;
        this.#favorite = favorite;
    }

    #encode () {
        if (this.isText()) {
            return this.getStringValue();
        }

        return [...this.#bytes]
            .map(x => x.toString(16).padStart(2, '0'))
            .join('');
    }

    getStringValue () {
        if (this.isImage()) {
            return `[Image ${this.asBytes().hash()}]`;
        }
        return new TextDecoder().decode(this.#bytes);
    }

    mimetype () {
        return this.#mimetype;
    }

    isFavorite () {
        return this.#favorite;
    }

    set favorite (val) {
        this.#favorite = !!val;
    }

    isText () {
        return this.#mimetype.startsWith('text/');
    }

    isImage () {
        return this.#mimetype.startsWith('image/');
    }

    asBytes () {
        return GLib.Bytes.new(this.#bytes);
    }

    equals (otherEntry) {
        return this.getStringValue() === otherEntry.getStringValue();
        // this.asBytes().equal(otherEntry.asBytes());
    }
}

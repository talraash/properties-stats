import { App, Plugin, TFile, Modal, ButtonComponent, Menu, Notice, FileSystemAdapter } from 'obsidian';

interface FrontmatterField {
    name: string;
    count: number;
    files: TFile[];
}

interface PluginSettings {
    pageSize: number;
    ignoreFields: string[];
}

const DEFAULT_SETTINGS: PluginSettings = {
    pageSize: 50,
    ignoreFields: []
};

export default class EnhancedFrontmatterStatsPlugin extends Plugin {
    settings!: PluginSettings;
    private cache: FrontmatterField[] = [];
    private lastUpdate = 0;

    async onload() {
        await this.loadSettings();
        
        this.addRibbonIcon('list', 'Frontmatter Statistics', () => {
            new StatsModal(this.app, this).open();
        });

        this.registerEvent(this.app.metadataCache.on('changed', () => this.clearCache()));
        this.registerEvent(this.app.vault.on('delete', () => this.clearCache()));
        this.registerEvent(this.app.vault.on('rename', () => this.clearCache()));
        this.registerEvent(this.app.vault.on('create', () => this.clearCache()));
    }

    clearCache() {
        this.cache = [];
        this.lastUpdate = 0;
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    async getFields(): Promise<FrontmatterField[]> {
        if (this.cache.length > 0 && Date.now() - this.lastUpdate < 300000) {
            return this.cache;
        }

        const fieldsMap: Record<string, FrontmatterField> = {};
        const markdownFiles = this.app.vault.getMarkdownFiles();
        const ignoreSet = new Set(this.settings.ignoreFields);

        for (const file of markdownFiles) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (!cache?.frontmatter) continue;

            const entries = this.flattenFrontmatter(cache.frontmatter);
            for (const [key] of entries) {
                if (ignoreSet.has(key)) continue;
                
                if (!fieldsMap[key]) {
                    fieldsMap[key] = { 
                        name: key, 
                        count: 0, 
                        files: []
                    };
                }
                
                fieldsMap[key].count++;
                fieldsMap[key].files.push(file);
            }
        }

        this.cache = Object.values(fieldsMap).sort((a, b) => b.count - a.count);
        this.lastUpdate = Date.now();
        return this.cache;
    }

    private flattenFrontmatter(obj: any, prefix = ''): [string, any][] {
        let result: [string, any][] = [];
        
        for (const [key, value] of Object.entries(obj)) {
            const fullKey = prefix ? `${prefix}.${key}` : key;
            
            if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                result = [...result, ...this.flattenFrontmatter(value, fullKey)];
            } else {
                result.push([fullKey, value]);
            }
        }
        
        return result;
    }
}

class StatsModal extends Modal {
    private fields: FrontmatterField[] = [];
    private currentField: FrontmatterField | null = null;
    private currentPage = 0;
    private filterTerm = '';
    private debounceTimeout: number | null = null;
    private plugin: EnhancedFrontmatterStatsPlugin;
    private searchInputEl: HTMLInputElement | null = null;

    constructor(app: App, plugin: EnhancedFrontmatterStatsPlugin) {
        super(app);
        this.plugin = plugin;
    }

    async onOpen() {
        this.fields = await this.plugin.getFields();
        this.renderMainView();
    }

    onClose() {
        this.contentEl.empty();
        if (this.debounceTimeout) {
            clearTimeout(this.debounceTimeout);
        }
        this.searchInputEl = null;
    }

    private renderMainView() {
        this.contentEl.empty();
        this.contentEl.addClass('frontmatter-stats');
        
        
        this.contentEl.createEl('h2', { text: 'Frontmatter Statistics' });
        
        // Search input
        const searchContainer = this.contentEl.createDiv({ cls: 'search-container' });
        searchContainer.createEl('label', { 
            text: 'Search:',
            attr: { for: 'frontmatter-search' }
        });
        
        this.searchInputEl = searchContainer.createEl('input', {
            type: 'text',
            attr: { 
                id: 'frontmatter-search', 
                placeholder: 'Filter parameters...' 
            },
            value: this.filterTerm
        }) as HTMLInputElement;
        
        this.searchInputEl.addEventListener('input', (e) => {
            this.filterTerm = (e.target as HTMLInputElement).value.toLowerCase();
            
            if (this.debounceTimeout) {
                clearTimeout(this.debounceTimeout);
            }
            
            this.debounceTimeout = window.setTimeout(() => {
                this.renderTable();
            }, 300);
        });
        
        this.renderTable();
    }

    private renderTable() {
        const existingTable = this.contentEl.querySelector('table');
        if (existingTable) existingTable.remove();
        
        const noResults = this.contentEl.querySelector('p.no-results');
        if (noResults) noResults.remove();
        
        const filteredFields = this.filterTerm ? 
            this.fields.filter(f => f.name.toLowerCase().includes(this.filterTerm)) : 
            this.fields;
        
        if (filteredFields.length === 0) {
            this.contentEl.createEl('p', { 
                text: 'No matching parameters found',
                cls: 'no-results'
            });
            return;
        }
        
        const table = this.contentEl.createEl('table');
        const headerRow = table.createEl('tr');
        headerRow.createEl('th', { text: 'Field' });
        headerRow.createEl('th', { text: 'Count' });
        headerRow.createEl('th', { text: 'Actions' });

        for (const field of filteredFields) {
            const row = table.createEl('tr');
            row.createEl('td', { text: field.name });
            row.createEl('td', { text: field.count.toString() });
            
            const actionCell = row.createEl('td');
            new ButtonComponent(actionCell)
                .setButtonText('Show Notes')
                .onClick(() => {
                    this.currentField = field;
                    this.currentPage = 0;
                    this.renderFileList();
                });
        }
    }

    private renderFileList() {
        if (!this.currentField) return;
        
        this.contentEl.empty();
        this.contentEl.addClass('frontmatter-stats');
        
        this.contentEl.createEl('h2', { 
            text: `Notes with "${this.currentField.name}"` 
        });
        
        const backButton = new ButtonComponent(this.contentEl)
            .setButtonText('← Back to All Parameters')
            .onClick(() => {
                this.currentField = null;
                this.currentPage = 0;
                this.renderMainView();
            });
        
        backButton.buttonEl.style.marginBottom = '15px';
        
        // File list
        const start = this.currentPage * this.plugin.settings.pageSize;
        const end = start + this.plugin.settings.pageSize;
        const paginatedFiles = this.currentField.files.slice(start, end);
        
        const list = this.contentEl.createEl('ul', { cls: 'file-list' });
        
        for (const file of paginatedFiles) {
            const item = list.createEl('li');
            const link = item.createEl('a', {
                text: file.basename,
                href: '#',
                cls: 'internal-link'
            });
            
            // Mouse click to open file
            link.onclick = (e) => {
                e.preventDefault();
                this.openFile(file);
            };
            
            // Context menu for file actions
            link.oncontextmenu = (e) => {
                e.preventDefault();
                this.showFileContextMenu(file, e);
            };
        }
        
        // Pagination functionality
        if (this.currentField.files.length > this.plugin.settings.pageSize) {
            const pagination = this.contentEl.createDiv({ cls: 'pagination' });
            
            if (this.currentPage > 0) {
                new ButtonComponent(pagination)
                    .setButtonText('← Previous')
                    .onClick(() => {
                        this.currentPage--;
                        this.renderFileList();
                    });
            }
            
            const pageInfo = pagination.createSpan({ 
                text: `Page ${this.currentPage + 1} of ${Math.ceil(this.currentField.files.length / this.plugin.settings.pageSize)}` 
            });
            
            if ((this.currentPage + 1) * this.plugin.settings.pageSize < this.currentField.files.length) {
                new ButtonComponent(pagination)
                    .setButtonText('Next →')
                    .onClick(() => {
                        this.currentPage++;
                        this.renderFileList();
                    });
            }
        }
    }

    private showFileContextMenu(file: TFile, e: MouseEvent) {
        const menu = new Menu(); 
        
        menu.addItem(item => item
            .setTitle("Open in current tab")
            .setIcon('document')
            .onClick(() => this.openFile(file)));
            
        menu.addItem(item => item
            .setTitle("Open in new tab")
            .setIcon('layout')
            .onClick(() => this.openFile(file, true)));
            
        menu.addItem(item => item
            .setTitle("Copy file path")
            .setIcon('copy')
            .onClick(() => navigator.clipboard.writeText(file.path)));
            
        menu.addItem(item => item
            .setTitle("Reveal in file explorer")
            .setIcon('folder')
            .onClick(() => {
                if (typeof window.require === 'function') {
                    try {
                        const { shell } = window.require('electron');
                        const adapter = this.app.vault.adapter;
                        if (adapter instanceof FileSystemAdapter) {
                            const fullPath = adapter.getFullPath(file.path);
                            shell.showItemInFolder(fullPath);
                        }
                    } catch (error) {
                        new Notice('Failed to reveal file: ');
                    }
                } else {
                    new Notice('This feature is only available in the desktop app');
                }
            }));
            
        menu.showAtPosition({ x: e.pageX, y: e.pageY });
    }

    private openFile(file: TFile, newPane = false) {
        const leaf = newPane ? 
            this.app.workspace.splitActiveLeaf() : 
            this.app.workspace.getLeaf();
        leaf.openFile(file);
        this.close();
    }
}
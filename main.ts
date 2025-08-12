import { App, Plugin, TFile, Modal, ButtonComponent, MarkdownView } from 'obsidian';

interface FrontmatterField {
    name: string;
    count: number;
    files: TFile[];
}

export default class FrontmatterStatsPlugin extends Plugin {
    async onload() {
        this.addRibbonIcon('list', 'Frontmatter Statistics', () => {
            new StatsModal(this.app).open();
        });
    }
}

class StatsModal extends Modal {
    private fields: FrontmatterField[] = [];
    private currentField: FrontmatterField | null = null;

    constructor(app: App) {
        super(app);
    }

    onOpen() {
        this.collectFrontmatterData();
        this.render();
    }

    onClose() {
        this.contentEl.empty();
    }

    private collectFrontmatterData() {
        const fieldsMap: Record<string, FrontmatterField> = {};
        const markdownFiles = this.app.vault.getMarkdownFiles();

        for (const file of markdownFiles) {
            const cache = this.app.metadataCache.getFileCache(file);
            if (!cache?.frontmatter) continue;

            for (const [key, value] of Object.entries(cache.frontmatter)) {
                if (!fieldsMap[key]) {
                    fieldsMap[key] = { name: key, count: 0, files: [] };
                }
                fieldsMap[key].count++;
                fieldsMap[key].files.push(file);
            }
        }

        this.fields = Object.values(fieldsMap).sort((a, b) => b.count - a.count);
    }

    private render() {
        this.contentEl.empty();
        
        if (this.currentField) {
            this.renderFileList();
        } else {
            this.renderMainView();
        }
    }

    private renderMainView() {
        this.contentEl.createEl('h2', { text: 'Frontmatter Statistics' });
        
        const table = this.contentEl.createEl('table');
        const headerRow = table.createEl('tr');
        headerRow.createEl('th', { text: 'Field' });
        headerRow.createEl('th', { text: 'Count' });
        headerRow.createEl('th', { text: 'Actions' });

        for (const field of this.fields) {
            const row = table.createEl('tr');
            row.createEl('td', { text: field.name });
            row.createEl('td', { text: field.count.toString() });
            
            const actionCell = row.createEl('td');
            new ButtonComponent(actionCell)
                .setButtonText('Show Notes')
                .onClick(() => {
                    this.currentField = field;
                    this.render();
                });
        }
    }

    private renderFileList() {
        if (!this.currentField) return;

        this.contentEl.createEl('h2', { 
            text: `Notes with "${this.currentField.name}"` 
        });
        
        new ButtonComponent(this.contentEl)
            .setButtonText('← Back')
            .onClick(() => {
                this.currentField = null;
                this.render();
            });
        
        const list = this.contentEl.createEl('ul');
        
        for (const file of this.currentField.files) {
            const item = list.createEl('li');
            const link = item.createEl('a', {
                text: file.basename,
                href: '#',
                cls: 'internal-link'
            });
            
            link.onclick = (e) => {
                e.preventDefault();
                this.openFile(file);
                this.close();
            };
        }
    }

    private openFile(file: TFile) {
        const leaf = this.app.workspace.getLeaf();
        leaf.openFile(file);
    }
}
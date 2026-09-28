// Qt6 accessibility fixture: same contract as gtk_bench.py — a small form
// that prints one line per real effect so tests verify semantic actions
// independently of the screen. Built with plain g++ and pkg-config Qt6Widgets
// (no moc needed: no custom signals/slots).
#include <QtWidgets/QApplication>
#include <QtWidgets/QWidget>
#include <QtWidgets/QVBoxLayout>
#include <QtWidgets/QLineEdit>
#include <QtWidgets/QCheckBox>
#include <QtWidgets/QPushButton>
#include <QtWidgets/QLabel>
#include <cstdio>

int main(int argc, char **argv) {
    QApplication app(argc, argv);
    QWidget window;
    window.setWindowTitle("AXI Qt Bench");
    auto *layout = new QVBoxLayout(&window);
    auto *name = new QLineEdit;
    name->setPlaceholderText("type a name");
    name->setAccessibleName("Name field");
    auto *agree = new QCheckBox("Agree");
    agree->setAccessibleName("Agree");
    auto *status = new QLabel("idle");
    status->setAccessibleName("Status");
    auto *save = new QPushButton("Save");
    save->setAccessibleName("Save button");
    layout->addWidget(name);
    layout->addWidget(agree);
    layout->addWidget(status);
    layout->addWidget(save);
    QObject::connect(name, &QLineEdit::textChanged, [](const QString &text) {
        printf("typed %s\n", text.toUtf8().constData());
        fflush(stdout);
    });
    QObject::connect(save, &QPushButton::clicked, [&] {
        printf("saved %s agree=%s\n", name->text().toUtf8().constData(),
               agree->isChecked() ? "true" : "false");
        status->setText(QString("Saved %1").arg(name->text()));
        fflush(stdout);
    });
    window.show();
    printf("ready\n");
    fflush(stdout);
    return app.exec();
}
